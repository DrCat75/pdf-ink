// PDF Ink – extension host side.
// Opens PDFs in a webview (pdf.js + ink canvases). Ink lives in a sidecar
// file next to the PDF: `<name>.pdf.ink.json`.
const vscode = require('vscode');
const path = require('path');

const VIEW_TYPE = 'pdfInk.editor';

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new InkEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('pdfInk.open', (uri) => {
      uri = uri || vscode.window.activeTextEditor?.document.uri || activeTabUri();
      if (!uri) return vscode.window.showWarningMessage('PDF Ink: no PDF selected.');
      vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    }),
  );
}

function activeTabUri() {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input && input.uri;
}

const sidecarUri = (pdfUri) => pdfUri.with({ path: pdfUri.path + '.ink.json' });

class InkEditorProvider {
  constructor(context) {
    this.context = context;
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, panel) {
    const pdfUri = document.uri;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [media, vscode.Uri.joinPath(pdfUri, '..')] };
    webview.html = this.html(webview, media);

    const inkUri = sidecarUri(pdfUri);
    const viewKey = 'view:' + pdfUri.toString();
    let writing = Promise.resolve();

    webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            const ink = await readJson(inkUri);
            webview.postMessage({
              type: 'init',
              name: path.basename(pdfUri.path),
              pdfUrl: webview.asWebviewUri(pdfUri).toString(),
              ink,
              prefs: this.context.globalState.get('prefs') || null,
              view: this.context.workspaceState.get(viewKey) || null,
              assets: {
                worker: webview.asWebviewUri(vscode.Uri.joinPath(media, 'pdf.worker.min.mjs')).toString(),
                base: webview.asWebviewUri(media).toString() + '/',
              },
            });
            break;
          }
          case 'needBytes': {
            // Fallback when the webview can't fetch the PDF URL. Base64 survives postMessage reliably.
            const raw = await vscode.workspace.fs.readFile(pdfUri);
            webview.postMessage({ type: 'bytes', b64: Buffer.from(raw).toString('base64') });
            break;
          }
          case 'save': {
            // Serialize writes so an older snapshot never overwrites a newer one.
            const data = Buffer.from(JSON.stringify(msg.ink));
            writing = writing.then(() => vscode.workspace.fs.writeFile(inkUri, data));
            await writing;
            webview.postMessage({ type: 'saved', seq: msg.seq });
            break;
          }
          case 'prefs':
            this.context.globalState.update('prefs', msg.prefs);
            break;
          case 'view':
            this.context.workspaceState.update(viewKey, msg.view);
            break;
          case 'export': {
            const base = pdfUri.path.replace(/\.pdf$/i, '');
            const target = await vscode.window.showSaveDialog({
              defaultUri: pdfUri.with({ path: base + '.annotated.pdf' }),
              filters: { PDF: ['pdf'] },
            });
            if (!target) return webview.postMessage({ type: 'exported', ok: false });
            await vscode.workspace.fs.writeFile(target, Buffer.from(msg.b64, 'base64'));
            webview.postMessage({ type: 'exported', ok: true });
            const pick = await vscode.window.showInformationMessage(
              `Exported ${path.basename(target.path)}`, 'Reveal');
            if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', target);
            break;
          }
          case 'error':
            vscode.window.showErrorMessage('PDF Ink: ' + msg.message);
            break;
        }
      } catch (err) {
        vscode.window.showErrorMessage('PDF Ink: ' + (err && err.message ? err.message : err));
        if (msg.type === 'save') webview.postMessage({ type: 'saveFailed', seq: msg.seq });
      }
    });
  }

  html(webview, media) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      `worker-src blob:`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('style.css')}">
</head>
<body>
<div id="toolbar"></div>
<div id="viewer"><div id="pages"></div></div>
<script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}

async function readJson(uri) {
  let raw;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch {
    return null; // no sidecar yet
  }
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch (err) {
    // Keep the unreadable file so nothing is lost when we write fresh ink.
    const backup = uri.with({ path: uri.path + '.corrupt-' + Date.now() });
    await vscode.workspace.fs.copy(uri, backup);
    vscode.window.showWarningMessage(`PDF Ink: could not parse ${path.basename(uri.path)} (${err.message}). Backed it up as ${path.basename(backup.path)} and started with empty ink.`);
    return null;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
