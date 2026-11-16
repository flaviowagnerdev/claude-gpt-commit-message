'use strict';
const vscode = require('vscode');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NS = 'claudeGptCommit';

const DEFAULT_SYSTEM_PROMPT = `Você escreve mensagens de commit do git.
Sua resposta será colada diretamente na caixa de mensagem de commit.
Não execute comandos, não edite arquivos e não faça commit: responda apenas com o texto da mensagem.

Regras:
- Escreva SEMPRE em português do Brasil (pt-BR), mesmo que o código, os comentários ou o diff estejam em outro idioma
- Siga a especificação Conventional Commits 1.0.0: tipo(escopo): descrição
- Os tipos ficam em inglês, como manda a especificação: feat, fix, refactor, perf, docs, style, test, build, ci, chore, revert
- O escopo é o módulo/feature afetado, em minúsculas (ex.: contato, comissoes); omita se não estiver claro
- Descrição no presente do indicativo (adiciona, corrige, remove), iniciando em minúscula, sem ponto final, com a primeira linha de até 72 caracteres
- Se houver várias mudanças relevantes, deixe uma linha em branco e um corpo curto em tópicos explicando o quê e por quê
- Mudanças incompatíveis: adicione ! após o tipo/escopo e um rodapé BREAKING CHANGE: com a explicação em português
- A primeira linha da resposta já deve ser o título do commit
- Sem introdução, explicação, observações ou blocos de código. Apenas a mensagem
- Nunca use o caractere crase, nem em volta de nomes de arquivo, classe ou método`;

const PROVIDERS = {
	claude: {
		label: 'Claude (Claude Code CLI)',
		// claude -p lê do stdin e escreve só a resposta no stdout. Sem ferramentas: só gera texto.
		build(cfg) {
			const exe = cfg.get('claude.path') || 'claude';
			const model = (cfg.get('claude.model') || '').trim();
			let cmd = `"${exe}" -p --tools ""`;
			if (model) { cmd += ` --model "${model}"`; }
			const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cfg.get('maxOutputTokens') || 1000) };
			return { cmd, exe, env };
		}
	},
	codex: {
		label: 'GPT (OpenAI Codex CLI)',
		// codex exec lê do stdin ("-"), roda em sandbox somente leitura e grava a resposta final em arquivo.
		build(cfg) {
			const exe = cfg.get('codex.path') || 'codex';
			const model = (cfg.get('codex.model') || '').trim();
			const outFile = path.join(os.tmpdir(), `claude-gpt-commit-${process.pid}-${Date.now()}.txt`);
			let cmd = `"${exe}" exec --sandbox read-only --ephemeral --skip-git-repo-check --color never -o "${outFile}"`;
			if (model) { cmd += ` -m "${model}"`; }
			cmd += ' -';
			return { cmd, exe, outFile, env: process.env };
		}
	}
};

function git(args, cwd) {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) { reject(new Error(stderr || err.message)); } else { resolve(stdout); }
		});
	});
}

async function getDiff(cwd) {
	const staged = await git(['diff', '--cached'], cwd);
	if (staged.trim()) { return { diff: staged, kind: 'staged' }; }
	const unstaged = await git(['diff'], cwd);
	if (unstaged.trim()) { return { diff: unstaged, kind: 'unstaged' }; }
	throw new Error('Nenhuma alteração encontrada (staged ou não).');
}

function lastLines(text, n = 6) {
	return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

function runProvider(providerId, input, cwd, token) {
	const cfg = vscode.workspace.getConfiguration(NS);
	const provider = PROVIDERS[providerId];
	if (!provider) { return Promise.reject(new Error(`IA desconhecida: "${providerId}". Use "claude" ou "codex".`)); }
	const { cmd, exe, outFile, env } = provider.build(cfg);
	const timeoutMs = (cfg.get('timeoutSeconds') || 120) * 1000;

	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (fn, val) => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			if (outFile) { fs.rm(outFile, { force: true }, () => {}); }
			fn(val);
		};

		const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env });
		let out = '';
		let err = '';
		const timer = setTimeout(() => { child.kill(); finish(reject, new Error('Tempo esgotado aguardando a resposta.')); }, timeoutMs);
		if (token) { token.onCancellationRequested(() => { child.kill(); finish(reject, new Error('Cancelado.')); }); }

		child.stdout.on('data', d => { out += d.toString(); });
		child.stderr.on('data', d => { err += d.toString(); });
		child.on('error', e => finish(reject, new Error(`Não foi possível executar "${exe}": ${e.message}`)));
		child.on('close', code => {
			if (code !== 0) {
				let msg = lastLines(err) || lastLines(out) || `${exe} saiu com código ${code}`;
				if (/output token maximum/i.test(msg)) {
					msg = `a resposta passou do limite de ${cfg.get('maxOutputTokens')} tokens. Aumente "Máximo de tokens da resposta" nas configurações.`;
				}
				finish(reject, new Error(msg));
				return;
			}
			if (outFile) {
				fs.readFile(outFile, 'utf8', (e, text) => {
					if (e) { finish(reject, new Error(`Resposta do ${exe} não encontrada: ${e.message}`)); } else { finish(resolve, text); }
				});
			} else {
				finish(resolve, out);
			}
		});
		child.stdin.end(input, 'utf8');
	});
}

function clean(text) {
	// Remove linhas de bloco de código (```lang / ```) e qualquer crase restante.
	let t = text
		.split(/\r?\n/)
		.filter(l => !/^\s*`{3,}/.test(l))
		.join('\n')
		.replace(/`/g, '')
		.trim();
	// Descarta uma eventual linha de introdução terminada em ":" (ex.: "Commit message:").
	const lines = t.split(/\r?\n/);
	if (lines.length > 1 && /:\s*$/.test(lines[0]) && !/^\w+(\([^)]*\))?!?:/.test(lines[0])) {
		t = lines.slice(1).join('\n').trim();
	}
	return t;
}

function systemPrompt(cfg) {
	const custom = (cfg.get('systemPrompt') || '').trim();
	return custom || DEFAULT_SYSTEM_PROMPT;
}

// O system prompt vai no início da entrada: os CLIs carregam as instruções globais do usuário
// (CLAUDE.md, hooks, AGENTS.md) e um --system-prompt por linha de comando não é respeitado de forma confiável.
function buildInput(cfg, kind, diff) {
	return `${systemPrompt(cfg)}

Git diff (alterações ${kind === 'staged' ? 'em stage' : 'fora do stage'}):
${diff}`;
}

async function pickRepo(gitApi, arg) {
	const repos = gitApi.repositories;
	if (arg && arg.rootUri) {
		const r = repos.find(x => x.rootUri.fsPath === arg.rootUri.fsPath);
		if (r) { return r; }
	}
	if (repos.length === 1) { return repos[0]; }
	if (repos.length === 0) { return undefined; }
	const sel = await vscode.window.showQuickPick(
		repos.map(r => ({ label: r.rootUri.fsPath, repo: r })),
		{ placeHolder: 'Selecione o repositório' }
	);
	return sel && sel.repo;
}

async function generate(arg) {
	try {
		const gitExt = vscode.extensions.getExtension('vscode.git');
		if (!gitExt) { throw new Error('Extensão Git do VS Code não disponível.'); }
		const gitApi = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
		const repo = await pickRepo(gitApi, arg);
		if (!repo) { throw new Error('Nenhum repositório Git encontrado.'); }
		const cwd = repo.rootUri.fsPath;

		const cfg = vscode.workspace.getConfiguration(NS);
		const providerId = cfg.get('provider') || 'claude';
		const maxChars = (cfg.get('maxInputTokens') || 30000) * 4;

		let { diff, kind } = await getDiff(cwd);
		if (diff.length > maxChars) { diff = diff.slice(0, maxChars) + '\n[diff truncated]'; }

		const label = PROVIDERS[providerId] ? PROVIDERS[providerId].label : providerId;
		const message = await vscode.window.withProgress({
			location: vscode.ProgressLocation.SourceControl,
			title: `${label}: gerando mensagem de commit...`,
			cancellable: true
		}, (_p, token) => runProvider(providerId, buildInput(cfg, kind, diff), cwd, token));

		const final = clean(message);
		if (!final) { throw new Error('A resposta veio vazia.'); }
		repo.inputBox.value = final;
	} catch (e) {
		if (e && e.message === 'Cancelado.') { return; }
		vscode.window.showErrorMessage(`Claude GPT Commit: ${e.message}`);
	}
}

async function selectProvider() {
	const cfg = vscode.workspace.getConfiguration(NS);
	const current = cfg.get('provider') || 'claude';
	const sel = await vscode.window.showQuickPick(
		Object.entries(PROVIDERS).map(([id, p]) => ({ label: p.label, description: id === current ? 'atual' : '', id })),
		{ placeHolder: 'IA para gerar mensagens de commit' }
	);
	if (!sel) { return; }
	await cfg.update('provider', sel.id, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`Claude GPT Commit: usando ${sel.label}.`);
}

// ---------------- Tela de configurações ----------------

function codexDefaultModel() {
	try {
		const toml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
		const m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
		return m ? m[1] : '';
	} catch { return ''; }
}

function currentSettings() {
	const cfg = vscode.workspace.getConfiguration(NS);
	return {
		provider: cfg.get('provider') || 'claude',
		claudeModel: cfg.get('claude.model') || '',
		codexModel: cfg.get('codex.model') || '',
		maxOutputTokens: cfg.get('maxOutputTokens'),
		maxInputTokens: cfg.get('maxInputTokens'),
		timeoutSeconds: cfg.get('timeoutSeconds'),
		systemPrompt: (cfg.get('systemPrompt') || '').trim() || DEFAULT_SYSTEM_PROMPT,
		defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
		codexDefaultModel: codexDefaultModel()
	};
}

async function saveSettings(s) {
	const cfg = vscode.workspace.getConfiguration(NS);
	const G = vscode.ConfigurationTarget.Global;
	const num = (v, min, def) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.round(n) : def; };
	const prompt = (s.systemPrompt || '').trim();
	await cfg.update('provider', s.provider === 'codex' ? 'codex' : 'claude', G);
	await cfg.update('claude.model', (s.claudeModel || '').trim(), G);
	await cfg.update('codex.model', (s.codexModel || '').trim(), G);
	await cfg.update('maxOutputTokens', num(s.maxOutputTokens, 50, 1000), G);
	await cfg.update('maxInputTokens', num(s.maxInputTokens, 500, 30000), G);
	await cfg.update('timeoutSeconds', num(s.timeoutSeconds, 10, 120), G);
	// Prompt igual ao padrão é gravado vazio, para acompanhar futuras mudanças do padrão.
	await cfg.update('systemPrompt', prompt === DEFAULT_SYSTEM_PROMPT.trim() ? undefined : prompt, G);
}

let panel;

function openSettings(context) {
	if (panel) { panel.reveal(); return; }
	panel = vscode.window.createWebviewPanel('claudeGptCommitSettings', 'Claude GPT Commit: Configurações', vscode.ViewColumn.Active, { enableScripts: true });
	panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
	panel.webview.html = settingsHtml(panel.webview);
	panel.onDidDispose(() => { panel = undefined; });
	panel.webview.onDidReceiveMessage(async msg => {
		if (msg.type === 'ready') {
			panel.webview.postMessage({ type: 'load', settings: currentSettings() });
		} else if (msg.type === 'save') {
			try {
				await saveSettings(msg.settings);
				panel.webview.postMessage({ type: 'saved', settings: currentSettings() });
			} catch (e) {
				panel.webview.postMessage({ type: 'error', message: e.message });
			}
		} else if (msg.type === 'test') {
			try {
				await saveSettings(msg.settings);
				const cfg = vscode.workspace.getConfiguration(NS);
				const provider = cfg.get('provider');
				const cwd = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || os.tmpdir();
				const sample = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Project\n+Install with npm install.';
				const t = Date.now();
				const out = clean(await runProvider(provider, buildInput(cfg, 'staged', sample), cwd));
				panel.webview.postMessage({ type: 'tested', text: out, secs: ((Date.now() - t) / 1000).toFixed(1) });
			} catch (e) {
				panel.webview.postMessage({ type: 'error', message: e.message });
			}
		}
	});
}

function settingsHtml(webview) {
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 24px 32px; max-width: 760px; }
	h1 { font-size: 1.4em; font-weight: 600; margin: 12px 0 4px; }
	.sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
	fieldset { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 12px 16px 16px; margin: 0 0 16px; }
	legend { padding: 0 6px; font-weight: 600; }
	label { display: block; margin: 12px 0 4px; font-weight: 600; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: 4px; }
	input, select, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 5px 7px; font-family: inherit; font-size: inherit; }
	input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	textarea { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); min-height: 280px; resize: vertical; line-height: 1.45; }
	.radios { display: flex; gap: 10px; flex-wrap: wrap; }
	.radio { flex: 1 1 220px; display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 10px 12px; cursor: pointer; font-weight: normal; margin: 0; }
	.radio input { width: auto; margin-top: 3px; }
	.radio.on { border-color: var(--vscode-focusBorder); background: var(--vscode-list-inactiveSelectionBackground); }
	.radio b { display: block; }
	.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 16px; }
	.hidden { display: none; }
	.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 6px 14px; cursor: pointer; font-family: inherit; font-size: inherit; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button { border: 1px solid var(--vscode-button-border, transparent); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: var(--vscode-button-border, var(--vscode-widget-border, var(--vscode-contrastBorder, #6b6b6b))); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: 0.6; cursor: default; }
	.status { color: var(--vscode-descriptionForeground); }
	.status.err { color: var(--vscode-errorForeground); }
	.footer { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 28px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding-top: 10px; }
	pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; margin: 12px 0 0; }
</style>
</head>
<body>
	<h1>Claude GPT Commit Message</h1>
	<p class="sub">Escolha a IA, o modelo, os limites de tokens e as instruções usadas para gerar a mensagem de commit.</p>

	<fieldset>
		<legend>IA</legend>
		<div class="radios">
			<label class="radio" id="r-claude"><input type="radio" name="provider" value="claude"><span><b>Claude</b>Claude Code CLI, com o login/assinatura do Claude</span></label>
			<label class="radio" id="r-codex"><input type="radio" name="provider" value="codex"><span><b>GPT</b>OpenAI Codex CLI, com o login do ChatGPT</span></label>
		</div>

		<div id="claude-box">
			<label for="claudeModel">Modelo do Claude</label>
			<input id="claudeModel" list="claude-models" placeholder="vazio = padrão do Claude Code">
			<datalist id="claude-models"><option value="haiku"><option value="sonnet"><option value="opus"></datalist>
			<div class="hint">Aliases: haiku (mais rápido), sonnet, opus. Também aceita um ID completo de modelo.</div>
		</div>
		<div id="codex-box">
			<label for="codexModel">Modelo do GPT</label>
			<input id="codexModel" placeholder="vazio = padrão do Codex">
			<div class="hint" id="codexHint">Vazio usa o modelo definido em ~/.codex/config.toml.</div>
		</div>
	</fieldset>

	<fieldset>
		<legend>Tokens e tempo</legend>
		<div class="row">
			<div>
				<label for="maxOutputTokens">Máximo de tokens da resposta</label>
				<input id="maxOutputTokens" type="number" min="50" step="50">
				<div class="hint" id="outHint">Se a resposta passar disso, a geração falha.</div>
			</div>
			<div>
				<label for="maxInputTokens">Máximo de tokens do diff</label>
				<input id="maxInputTokens" type="number" min="500" step="1000">
				<div class="hint">Aproximado (4 caracteres por token). O excedente é cortado.</div>
			</div>
			<div>
				<label for="timeoutSeconds">Tempo máximo (segundos)</label>
				<input id="timeoutSeconds" type="number" min="10" step="10">
			</div>
		</div>
	</fieldset>

	<fieldset>
		<legend>System prompt</legend>
		<textarea id="systemPrompt" spellcheck="false"></textarea>
		<div class="hint">Instruções enviadas antes do diff. O diff é anexado automaticamente no final.</div>
		<div class="actions"><button class="secondary" id="reset">Restaurar prompt padrão</button></div>
	</fieldset>

	<div class="actions">
		<button id="save">Salvar</button>
		<button class="secondary" id="test">Salvar e testar</button>
		<span class="status" id="status"></span>
	</div>
	<pre id="result" class="hidden"></pre>

	<p class="footer">Claude GPT Commit Message · desenvolvido por Flávio Wagner</p>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	let defaults = {};

	function provider() { return document.querySelector('input[name=provider]:checked').value; }

	function sync() {
		const p = provider();
		$('r-claude').classList.toggle('on', p === 'claude');
		$('r-codex').classList.toggle('on', p === 'codex');
		$('claude-box').classList.toggle('hidden', p !== 'claude');
		$('codex-box').classList.toggle('hidden', p !== 'codex');
		$('outHint').textContent = p === 'claude'
			? 'Se a resposta passar disso, a geração falha.'
			: 'O Codex CLI não permite limitar a resposta; este valor vale só para o Claude.';
	}

	function collect() {
		return {
			provider: provider(),
			claudeModel: $('claudeModel').value,
			codexModel: $('codexModel').value,
			maxOutputTokens: $('maxOutputTokens').value,
			maxInputTokens: $('maxInputTokens').value,
			timeoutSeconds: $('timeoutSeconds').value,
			systemPrompt: $('systemPrompt').value
		};
	}

	function load(s) {
		defaults = s;
		document.querySelector('input[name=provider][value=' + s.provider + ']').checked = true;
		$('claudeModel').value = s.claudeModel;
		$('codexModel').value = s.codexModel;
		$('codexModel').placeholder = s.codexDefaultModel ? 'vazio = ' + s.codexDefaultModel + ' (padrão do Codex)' : 'vazio = padrão do Codex';
		$('maxOutputTokens').value = s.maxOutputTokens;
		$('maxInputTokens').value = s.maxInputTokens;
		$('timeoutSeconds').value = s.timeoutSeconds;
		$('systemPrompt').value = s.systemPrompt;
		sync();
	}

	function status(text, err) { $('status').textContent = text; $('status').className = 'status' + (err ? ' err' : ''); }
	function busy(b) { $('save').disabled = b; $('test').disabled = b; }

	document.querySelectorAll('input[name=provider]').forEach(r => r.addEventListener('change', sync));
	$('reset').addEventListener('click', () => { $('systemPrompt').value = defaults.defaultSystemPrompt; status('Prompt padrão restaurado. Clique em Salvar para aplicar.'); });
	$('save').addEventListener('click', () => { busy(true); status('Salvando...'); vscode.postMessage({ type: 'save', settings: collect() }); });
	$('test').addEventListener('click', () => {
		busy(true); $('result').classList.add('hidden');
		status('Salvando e gerando uma mensagem de teste com um diff de exemplo...');
		vscode.postMessage({ type: 'test', settings: collect() });
	});

	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'load') { load(m.settings); }
		else if (m.type === 'saved') { busy(false); load(m.settings); status('Configurações salvas.'); }
		else if (m.type === 'tested') { busy(false); status('Teste concluído em ' + m.secs + ' s:'); $('result').textContent = m.text; $('result').classList.remove('hidden'); }
		else if (m.type === 'error') { busy(false); status('Erro: ' + m.message, true); }
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand(`${NS}.generate`, generate),
		vscode.commands.registerCommand(`${NS}.selectProvider`, selectProvider),
		vscode.commands.registerCommand(`${NS}.openSettings`, () => openSettings(context))
	);
}

function deactivate() {}

module.exports = { activate, deactivate, clean };
