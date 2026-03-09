import * as vscode from 'vscode';

const getApiUrl = () => vscode.workspace.getConfiguration('forge').get<string>('apiUrl', 'http://localhost:3737');

// ── API helpers ────────────────────────────────────────────────────────────────
async function forgeApi(path: string, method = 'GET', body?: object): Promise<any> {
  const url = `${getApiUrl()}${path}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Forge API ${path} → ${r.status}`);
  return r.json();
}

async function forgeStream(path: string, body: object, onToken: (t: string) => void): Promise<void> {
  const url = `${getApiUrl()}${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!r.ok || !r.body) throw new Error(`Stream failed: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const d = JSON.parse(line.slice(6));
          if (d.token) onToken(d.token);
          if (d.done) return;
        } catch {}
      }
    }
  }
}

// ── Inline Completions Provider ────────────────────────────────────────────────
class ForgeCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastRequestId = 0;

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const cfg = vscode.workspace.getConfiguration('forge');
    if (!cfg.get('enableInlineCompletions')) return null;

    // Get prefix (last 1500 chars) and suffix (next 500 chars)
    const offset = doc.offsetAt(pos);
    const fullText = doc.getText();
    const prefix = fullText.slice(Math.max(0, offset - 1500), offset);
    const suffix = fullText.slice(offset, Math.min(fullText.length, offset + 500));

    if (prefix.trim().length < 3) return null;

    const delay = cfg.get<number>('completionDelay', 600);
    await new Promise<void>(resolve => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(resolve, delay);
    });
    if (token.isCancellationRequested) return null;

    const reqId = ++this.lastRequestId;

    try {
      const lang = doc.languageId;
      const result = await forgeApi('/complete/fim', 'POST', {
        prefix, suffix, lang,
        maxTokens: 150,
        model: cfg.get('model', 'phi3.5-forge')
      });
      if (token.isCancellationRequested || reqId !== this.lastRequestId) return null;
      if (!result.completion || result.completion.trim().length === 0) return null;

      return {
        items: [new vscode.InlineCompletionItem(
          result.completion,
          new vscode.Range(pos, pos)
        )]
      };
    } catch {
      return null;
    }
  }
}

// ── Chat Panel ─────────────────────────────────────────────────────────────────
class ForgeChatPanel {
  static currentPanel: ForgeChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _messages: Array<{role: string, content: string}> = [];

  static createOrShow(extensionUri: vscode.Uri) {
    if (ForgeChatPanel.currentPanel) {
      ForgeChatPanel.currentPanel._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'forgeChat', 'Forge Chat', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ForgeChatPanel.currentPanel = new ForgeChatPanel(panel, extensionUri);
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => { ForgeChatPanel.currentPanel = undefined; });
    this._panel.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'send') {
        await this._handleMessage(msg.text, msg.projectId);
      }
    });
  }

  private async _handleMessage(text: string, projectId?: string) {
    this._messages.push({ role: 'user', content: text });
    this._panel.webview.postMessage({ command: 'userMsg', text });

    let fullResponse = '';
    this._panel.webview.postMessage({ command: 'startAssistant' });
    try {
      await forgeStream('/chat', { message: text, projectId }, (token) => {
        fullResponse += token;
        this._panel.webview.postMessage({ command: 'token', token });
      });
    } catch {
      // Fallback to non-streaming
      try {
        const r = await forgeApi('/chat', 'POST', { message: text, projectId });
        fullResponse = r.response || r.message || '';
        this._panel.webview.postMessage({ command: 'token', token: fullResponse });
      } catch(e: any) {
        this._panel.webview.postMessage({ command: 'token', token: `❌ Error: ${e.message}` });
      }
    }
    this._messages.push({ role: 'assistant', content: fullResponse });
    this._panel.webview.postMessage({ command: 'endAssistant' });
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); height: 100vh; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .msg { padding: 10px 14px; border-radius: 8px; max-width: 90%; line-height: 1.5; white-space: pre-wrap; font-size: 13px; }
  .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
  .assistant { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); align-self: flex-start; }
  .assistant code { background: var(--vscode-textCodeBlock-background); padding: 2px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  #input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--vscode-panel-border); }
  #input { flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; color: var(--vscode-input-foreground); padding: 8px 12px; font-size: 13px; resize: none; font-family: inherit; }
  #input:focus { outline: none; border-color: var(--vscode-focusBorder); }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  .thinking { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
  #header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; }
</style>
</head>
<body>
<div id="header"><div class="dot"></div>⚡ Forge Chat</div>
<div id="messages">
  <div class="msg assistant">👋 Hi! I'm Forge, your local AI dev assistant. Ask me to explain code, fix bugs, write tests, or anything else. Select code in the editor and ask about it!</div>
</div>
<div id="input-row">
  <textarea id="input" rows="3" placeholder="Ask Forge anything... (Shift+Enter for new line)"></textarea>
  <button id="send">Send</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const msgs = document.getElementById('messages');
  const input = document.getElementById('input');
  let currentAssistantDiv = null;

  document.getElementById('send').onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ command: 'send', text });
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'userMsg') {
      const d = document.createElement('div');
      d.className = 'msg user';
      d.textContent = msg.text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
    } else if (msg.command === 'startAssistant') {
      currentAssistantDiv = document.createElement('div');
      currentAssistantDiv.className = 'msg assistant thinking';
      currentAssistantDiv.textContent = '⟳ Thinking...';
      msgs.appendChild(currentAssistantDiv);
      msgs.scrollTop = msgs.scrollHeight;
    } else if (msg.command === 'token') {
      if (currentAssistantDiv) {
        if (currentAssistantDiv.classList.contains('thinking')) {
          currentAssistantDiv.classList.remove('thinking');
          currentAssistantDiv.textContent = '';
        }
        currentAssistantDiv.textContent += msg.token;
        msgs.scrollTop = msgs.scrollHeight;
      }
    } else if (msg.command === 'endAssistant') {
      currentAssistantDiv = null;
    }
  });
</script>
</body>
</html>`;
  }
}

// ── Code Action Commands ───────────────────────────────────────────────────────
async function runCodeAction(action: 'explain' | 'fix' | 'refactor' | 'test') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return vscode.window.showErrorMessage('No active editor');

  const selection = editor.selection;
  const code = editor.document.getText(selection.isEmpty ? undefined : selection);
  const lang = editor.document.languageId;
  const filename = editor.document.fileName.split('/').pop() || '';

  const labels: Record<string, string> = { explain: 'Explaining', fix: 'Fixing', refactor: 'Refactoring', test: 'Generating tests for' };

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `⚡ Forge: ${labels[action]} code...`,
    cancellable: false
  }, async () => {
    try {
      const result = await forgeApi('/code/' + (action === 'test' ? 'generate-tests' : action), 'POST', {
        code, lang, filename
      });
      const output = result.explanation || result.refactored || result.tests || result.fixed || result.result || '';

      if (action === 'explain') {
        // Show in output channel
        const channel = vscode.window.createOutputChannel('Forge: Explanation');
        channel.appendLine(output);
        channel.show(true);
      } else {
        // Show diff or replace in editor
        const doc = await vscode.workspace.openTextDocument({ content: output, language: lang });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(`✅ Forge ${action} complete! Review the result →`);
      }
    } catch(e: any) {
      vscode.window.showErrorMessage(`Forge error: ${e.message}`);
    }
  });
}

// ── Status Bar ─────────────────────────────────────────────────────────────────
function createStatusBar(ctx: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'forge.chat';
  item.text = '$(zap) Forge';
  item.tooltip = 'Open Forge Chat (Ctrl+Shift+F)';
  item.backgroundColor = undefined;
  ctx.subscriptions.push(item);
  item.show();

  // Check if Forge is online every 30s
  const check = async () => {
    try {
      await forgeApi('/health');
      item.text = '$(zap) Forge';
      item.color = undefined;
    } catch {
      item.text = '$(zap) Forge ⚠';
      item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    }
  };
  check();
  setInterval(check, 30000);
  return item;
}

// ── Activation ────────────────────────────────────────────────────────────────
export function activate(ctx: vscode.ExtensionContext) {
  // Status bar
  createStatusBar(ctx);

  // Inline completions
  ctx.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new ForgeCompletionProvider()
    )
  );

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('forge.chat', () => ForgeChatPanel.createOrShow(ctx.extensionUri)),
    vscode.commands.registerCommand('forge.explain', () => runCodeAction('explain')),
    vscode.commands.registerCommand('forge.fix', () => runCodeAction('fix')),
    vscode.commands.registerCommand('forge.refactor', () => runCodeAction('refactor')),
    vscode.commands.registerCommand('forge.test', () => runCodeAction('test')),
    vscode.commands.registerCommand('forge.runTask', async () => {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '⚡ Forge: Running next task...',
        cancellable: false
      }, () => forgeApi('/task/run-next', 'POST'));
      if (result.taskId) {
        vscode.window.showInformationMessage(`✅ Task done! Score: ${result.qualityScore}/10 — ${result.title}`);
      } else {
        vscode.window.showInformationMessage(result.message || 'No pending tasks');
      }
    }),
    vscode.commands.registerCommand('forge.indexWorkspace', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) return vscode.window.showErrorMessage('No workspace open');
      vscode.window.showInformationMessage('⚡ Forge: Indexing workspace...');
      // Future: post files to /workspace/index
    })
  );

  vscode.window.showInformationMessage('⚡ Forge AI is ready! Press Ctrl+Shift+F to chat.');
}

export function deactivate() {}
