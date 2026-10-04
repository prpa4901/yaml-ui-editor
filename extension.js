'use strict';
const vscode = require('vscode');
const YAML   = require('yaml');

// ─────────────────────────────────────────────────────────────────────────────
//  YAML helpers (extension host)
//  The form data is merged back INTO the original document tree, so comments,
//  blank lines and quoting style of everything you did not touch are preserved.
// ─────────────────────────────────────────────────────────────────────────────
function parseText(text) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const data = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Top-level must be a mapping.');
  }
  return { doc, data };
}

function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// drop internal "__src" bookkeeping keys
function clean(v) {
  return JSON.parse(JSON.stringify(v, function (k, x) {
    return (typeof k === 'string' && k.indexOf('__') === 0) ? undefined : x;
  }));
}

function stripComments(node) {
  YAML.visit(node, {
    Node(_, n) { n.comment = undefined; n.commentBefore = undefined; }
  });
}

function keyName(pair) {
  return String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
}

function sync(doc, node, val) {
  if (Array.isArray(val)) {
    return YAML.isSeq(node) ? syncSeq(doc, node, val) : doc.createNode(clean(val));
  }
  if (isPlainObj(val)) {
    return YAML.isMap(node) ? syncMap(doc, node, val) : doc.createNode(clean(val));
  }
  // scalar: only touch it if the value really changed (keeps quotes + trailing comment)
  if (YAML.isScalar(node)) {
    if (node.value !== val) node.value = val;
    return node;
  }
  return doc.createNode(val);
}

function syncMap(doc, map, obj) {
  const keys = Object.keys(obj).filter(k => k.indexOf('__') !== 0);

  // omitted keys disappear
  map.items = map.items.filter(p => keys.indexOf(keyName(p)) !== -1);

  // existing keys: update in place
  const have = {};
  map.items.forEach(p => {
    const k = keyName(p);
    have[k] = true;
    p.value = sync(doc, p.value, obj[k]);
  });

  // keys that did not exist before (rare from the UI)
  keys.forEach(k => { if (!have[k]) map.set(k, doc.createNode(clean(obj[k]))); });
  return map;
}

function syncSeq(doc, seq, arr) {
  const orig   = seq.items.slice();
  const spaced = orig.slice(1).some(n => n && n.spaceBefore);   // list uses blank lines between items?
  const objMode = arr.length > 0 && isPlainObj(arr[0]);

  if (objMode) {
    const pristine = orig.map(n => n.clone());   // untouched copies, used for Duplicate
    const used = {};
    seq.items = arr.map((item, i) => {
      const src = item && item.__src;
      let node;
      if (!isPlainObj(item)) {
        node = doc.createNode(item);
      } else if (Number.isInteger(src) && orig[src]) {
        if (!used[src]) {
          used[src] = true;
          node = orig[src];
        } else {
          node = pristine[src].clone();          // duplicate: same structure, no copied comments
          stripComments(node);
        }
        node = sync(doc, node, item);
      } else {
        node = doc.createNode(clean(item));
      }
      return node;
    });

    // blank lines between items. A trailing comment on the previous item may already
    // carry the blank line (the library stores it as a final "\n" in that comment).
    if (spaced) {
      seq.items.forEach((node, i) => {
        if (i === 0) { node.spaceBefore = false; return; }
        const prev = seq.items[i - 1];
        const prevEndsBlank = typeof prev.comment === 'string' && /\n$/.test(prev.comment);
        node.spaceBefore = !prevEndsBlank;
      });
    }
    return seq;
  }

  // list of plain values (strings / numbers)
  const pool     = orig.slice();
  const styleRef = orig.find(n => YAML.isScalar(n) && typeof n.value === 'string');
  if (orig.length === 0 && arr.length > 0) seq.flow = false;   // "[]" -> block list
  seq.items = arr.map(v => {
    const idx = pool.findIndex(n => YAML.isScalar(n) && n.value === v);
    if (idx >= 0) return pool.splice(idx, 1)[0];             // untouched item keeps its comment/quotes
    const n = doc.createNode(v);
    if (typeof v === 'string' && styleRef && styleRef.type) n.type = styleRef.type;  // copy sibling's quote style
    return n;
  });
  return seq;
}

function buildYaml(baseText, data) {
  const { doc } = parseText(baseText);
  doc.contents = sync(doc, doc.contents, data);
  return doc.toString({
    lineWidth: 0,                       // never re-wrap long strings
    defaultStringType: 'QUOTE_DOUBLE',  // brand-new strings get "double quotes"
    defaultKeyType: 'PLAIN'             // ...but keys stay unquoted
  });
}

// ─────────────────────────────────────────────────────────────────────────────
function activate(context) {
  const cmd = vscode.commands.registerCommand('yamlui.openForm', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open a YAML file first.'); return; }

    const doc = editor.document;
    let baseText = doc.getText();
    let parsed;
    try {
      parsed = parseText(baseText);
    } catch (e) {
      vscode.window.showErrorMessage('YAML parse error: ' + e.message);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'yamlUiEditor',
      'Form: ' + doc.fileName.split(/[\\/]/).pop(),
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = buildHtml(parsed.data);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.command !== 'applyToEditor') return;

      if (doc.getText() !== baseText) {
        vscode.window.showWarningMessage(
          'The YAML file changed after the form was opened. Close and reopen the form so your edits are not overwritten.');
        return;
      }

      let newText;
      try {
        newText = buildYaml(baseText, msg.data);
      } catch (e) {
        vscode.window.showErrorMessage('Could not build YAML: ' + e.message);
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri,
        new vscode.Range(doc.positionAt(0), doc.positionAt(baseText.length)),
        newText);

      vscode.workspace.applyEdit(edit).then(ok => {
        if (!ok) { vscode.window.showErrorMessage('Could not update the file.'); return; }
        baseText = doc.getText();
        try { panel.webview.postMessage({ command: 'reset', data: parseText(baseText).data }); } catch (e) {}
        vscode.window.showInformationMessage('YAML updated ✔');
      });
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(cmd);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Browser-side code. A REAL function (not a string) so nothing can be mangled by
//  escaping. Serialised with .toString() and executed inside the webview.
//  It must not reference anything outside itself.
// ─────────────────────────────────────────────────────────────────────────────
function clientMain(initial) {
  var vscodeApi = acquireVsCodeApi();

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // Tag every object inside a list with the index it came from in the file.
  // The extension host uses this to match form items back to the original YAML.
  function annotate(v) {
    if (Array.isArray(v)) {
      v.forEach(function (item, i) {
        if (isObj(item)) item.__src = i;
        annotate(item);
      });
    } else if (isObj(v)) {
      Object.keys(v).forEach(function (k) { if (k.indexOf('__') !== 0) annotate(v[k]); });
    }
    return v;
  }

  var appData      = annotate(initial);
  var originalData = JSON.parse(JSON.stringify(appData));

  // Which cards/sections are open, keyed by their path. Default = everything collapsed.
  var openState = {};

  // when list items move (add/duplicate/remove) keep the open/closed state attached to the right item
  function remapOpen(path, fn) {
    var next = {};
    Object.keys(openState).forEach(function (k) {
      var arr = JSON.parse(k), n = path.length, match = arr.length > n;
      for (var i = 0; match && i < n; i++) { if (arr[i] !== path[i]) match = false; }
      if (match && typeof arr[n] === 'number') {
        var ni = fn(arr[n]);
        if (ni < 0) return;
        arr[n] = ni;
      }
      next[JSON.stringify(arr)] = true;
    });
    openState = next;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function P(path) { return esc(JSON.stringify(path)); }

  function getByPath(obj, parts) {
    var c = obj;
    for (var i = 0; i < parts.length; i++) c = c[parts[i]];
    return c;
  }

  function blankOf(v) {
    if (Array.isArray(v)) return [];
    if (isObj(v)) {
      var r = {};
      Object.keys(v).forEach(function (k) { if (k.indexOf('__') !== 0) r[k] = blankOf(v[k]); });
      return r;
    }
    if (typeof v === 'number')  return 0;
    if (typeof v === 'boolean') return false;
    return '';
  }

  function cardLabel(item, idx) {
    var pref  = ['id', 'name', 'key', 'title', 'label'];
    var parts = [];
    pref.forEach(function (k) {
      if (parts.length < 2 && item[k] !== undefined && item[k] !== null && typeof item[k] !== 'object') {
        parts.push(esc(k) + ': ' + esc(item[k]));
      }
    });
    if (!parts.length) {
      var ks = Object.keys(item);
      for (var i = 0; i < ks.length; i++) {
        var v = item[ks[i]];
        if (ks[i].indexOf('__') !== 0 && v !== null && typeof v !== 'object') {
          parts.push(esc(ks[i]) + ': ' + esc(v));
          break;
        }
      }
    }
    return parts.length ? parts.join(' &middot; ') : 'Item ' + (idx + 1);
  }

  function omitBtn(path) {
    return '<button class="btn-omit" data-act="omit" data-path="' + P(path) +
           '" title="Omit this field from the YAML output">&minus; omit</button>';
  }

  function buildPrimitive(val, path, inline) {
    if (typeof val === 'boolean') {
      return '<select data-path="' + P(path) + '">' +
        '<option value="true"'  + (val  ? ' selected' : '') + '>true</option>'  +
        '<option value="false"' + (!val ? ' selected' : '') + '>false</option>' +
        '</select>';
    }
    if (typeof val === 'number') {
      return '<input type="number" step="any" data-path="' + P(path) + '" value="' + val + '">';
    }
    var sv = String(val == null ? '' : val);
    if (!inline && sv.indexOf('\n') !== -1) {
      return '<textarea data-path="' + P(path) + '" rows="3">' + esc(sv) + '</textarea>';
    }
    return '<input type="text" data-path="' + P(path) + '" value="' + esc(sv) + '">';
  }

  function buildArray(arr, path) {
    var html = '';
    if (arr.length > 0 && isObj(arr[0])) {
      arr.forEach(function (item, i) {
        html +=
          '<details class="array-card" data-key="' + P(path.concat([i])) + '"' +
            (openState[JSON.stringify(path.concat([i]))] ? ' open' : '') + '>' +
            '<summary>' +
              '<span class="card-label">' + cardLabel(item, i) + '</span>' +
              '<span class="card-actions">' +
                '<button class="btn-dup" data-act="dup" data-path="' + P(path) + '" data-idx="' + i + '">Duplicate</button>' +
                '<button class="btn-remove" data-act="rm" data-path="' + P(path) + '" data-idx="' + i + '">Remove</button>' +
              '</span>' +
            '</summary>' +
            '<div class="array-card-body">' + buildObject(item, path.concat([i])) + '</div>' +
          '</details>';
      });
      html += '<button class="btn-add-card" data-act="add" data-path="' + P(path) + '">+ Add ' +
              esc(path[path.length - 1]) + ' (blank)</button>';
      return html;
    }

    html = '<div class="prim-list">';
    arr.forEach(function (item, i) {
      html += '<div class="prim-row">' +
        buildPrimitive(item, path.concat([i]), true) +
        '<button class="btn-x" data-act="rm" data-path="' + P(path) + '" data-idx="' + i + '" title="Remove">&times;</button>' +
        '</div>';
    });
    html += '<button class="btn-add-prim" data-act="addp" data-path="' + P(path) + '">+ Add</button></div>';
    return html;
  }

  function buildObject(obj, path) {
    var html = '';
    Object.keys(obj).forEach(function (key) {
      if (key.indexOf('__') === 0) return;          // hide internal bookkeeping
      var val = obj[key];
      var cp  = path.concat([key]);

      if (isObj(val)) {
        html += '<details class="obj-details" data-key="' + P(cp) + '"' +
          (openState[JSON.stringify(cp)] ? ' open' : '') + '><summary>' +
          '<span class="obj-key">' + esc(key) + '</span>' + omitBtn(cp) +
          '</summary><div class="obj-body">' + buildObject(val, cp) + '</div></details>';
      } else if (Array.isArray(val)) {
        html += '<div class="field"><div class="field-hdr"><label>' + esc(key) + '</label>' +
          omitBtn(cp) + '</div>' + buildArray(val, cp) + '</div>';
      } else {
        html += '<div class="field"><div class="field-hdr"><label>' + esc(key) + '</label>' +
          omitBtn(cp) + '</div>' + buildPrimitive(val, cp, false) + '</div>';
      }
    });
    return html;
  }

  function render() {
    var y = window.scrollY;
    var html = '';
    Object.keys(appData).forEach(function (key) {
      if (key.indexOf('__') === 0) return;
      var val = appData[key];
      html += '<div class="top-key">' + esc(key) + '</div>';
      if (Array.isArray(val))  html += buildArray(val, [key]);
      else if (isObj(val))     html += buildObject(val, [key]);
      else                     html += '<div class="field">' + buildPrimitive(val, [key], false) + '</div>';
    });
    document.getElementById('form-root').innerHTML = html;
    window.scrollTo(0, y);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();

    var act  = b.dataset.act;
    var path = JSON.parse(b.dataset.path);
    var idx  = parseInt(b.dataset.idx, 10);

    if (act === 'omit') {
      delete getByPath(appData, path.slice(0, -1))[path[path.length - 1]];
    } else if (act === 'dup') {
      var a1 = getByPath(appData, path);
      a1.splice(idx + 1, 0, JSON.parse(JSON.stringify(a1[idx])));
      remapOpen(path, function (i) { return i > idx ? i + 1 : i; });
      openState[JSON.stringify(path.concat([idx + 1]))] = true;     // show the new copy
    } else if (act === 'rm') {
      getByPath(appData, path).splice(idx, 1);
      remapOpen(path, function (i) { return i === idx ? -1 : (i > idx ? i - 1 : i); });
    } else if (act === 'add') {
      var a2    = getByPath(appData, path);
      var blank = a2.length ? blankOf(a2[0]) : {};
      // reuse the first item's original node so quote style/structure carry over
      if (a2.length && a2[0].__src !== undefined) blank.__src = a2[0].__src;
      a2.push(blank);
      openState[JSON.stringify(path.concat([a2.length - 1]))] = true;   // show the new item
    } else if (act === 'addp') {
      var a3 = getByPath(appData, path);
      a3.push(a3.length && typeof a3[0] === 'number' ? 0 : '');
    }
    render();
  });

  function onValue(e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.path) return;
    var path   = JSON.parse(el.dataset.path);
    var parent = getByPath(appData, path.slice(0, -1));
    var key    = path[path.length - 1];
    var curr   = parent[key];
    var raw    = el.value;
    if (typeof curr === 'number')       parent[key] = raw === '' ? 0 : Number(raw);
    else if (typeof curr === 'boolean') parent[key] = raw === 'true';
    else                                parent[key] = raw;
  }
  document.addEventListener('input',  onValue);
  document.addEventListener('change', onValue);

  document.getElementById('btnApply').addEventListener('click', function () {
    vscodeApi.postMessage({ command: 'applyToEditor', data: appData });
    var s = document.getElementById('status');
    s.textContent = 'Applying…';
    setTimeout(function () { s.textContent = ''; }, 2500);
  });

  document.getElementById('btnReset').addEventListener('click', function () {
    appData = JSON.parse(JSON.stringify(originalData));
    render();
    document.getElementById('status').textContent = '';
  });

  // after a successful Apply the host sends the fresh file contents
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.command === 'reset') {
      appData      = annotate(m.data);
      originalData = JSON.parse(JSON.stringify(appData));
      render();
    }
  });

  // remember what the user opens/closes (the toggle event does not bubble, so listen in capture phase)
  document.addEventListener('toggle', function (e) {
    var t = e.target;
    if (!t || !t.dataset || !t.dataset.key) return;
    if (t.open) openState[t.dataset.key] = true; else delete openState[t.dataset.key];
  }, true);

  document.getElementById('btnExpand').addEventListener('click', function () {
    var list = document.querySelectorAll('details[data-key]');
    for (var i = 0; i < list.length; i++) openState[list[i].dataset.key] = true;
    render();
  });
  document.getElementById('btnCollapse').addEventListener('click', function () {
    openState = {};
    render();
  });

  render();
}

function buildHtml(data) {
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const script   = '(' + clientMain.toString() + ')(' + safeJson + ');';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 24px 48px; margin: 0;
  }
  h2 { margin: 0 0 16px; font-size: 1.1em; }

  .top-key {
    font-size: 12px; font-weight: 700; margin: 24px 0 10px;
    padding-bottom: 5px; border-bottom: 2px solid var(--vscode-panel-border, #444);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .top-key:first-child { margin-top: 0; }

  .field { margin-bottom: 10px; }
  .field-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
  label {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }

  .btn-omit {
    background: none; border: none; cursor: pointer; padding: 0 2px;
    font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.5;
  }
  .btn-omit:hover { color: var(--vscode-errorForeground, #f44); opacity: 1; }

  input[type=text], input[type=number], select, textarea {
    width: 100%; padding: 5px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px; font: inherit; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea { resize: vertical; }

  .array-card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; margin-bottom: 7px; }
  .array-card > summary {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; background: var(--vscode-sideBarSectionHeader-background, #252526);
    cursor: pointer; user-select: none; list-style: none;
    font-weight: 600; font-size: 12px; border-radius: 4px;
  }
  .array-card[open] > summary { border-radius: 4px 4px 0 0; }
  .array-card > summary::-webkit-details-marker { display: none; }
  .card-label::before { content: '\\25B6  '; font-size: 9px; }
  .array-card[open] .card-label::before { content: '\\25BC  '; font-size: 9px; }
  .card-actions { display: flex; gap: 5px; flex-shrink: 0; }
  .array-card-body { padding: 12px; border-top: 1px solid var(--vscode-panel-border, #444); }

  .obj-details { margin-bottom: 8px; }
  .obj-details > summary {
    display: flex; justify-content: space-between; align-items: center;
    cursor: pointer; user-select: none; list-style: none; padding: 4px 0;
  }
  .obj-details > summary::-webkit-details-marker { display: none; }
  .obj-key {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .obj-key::before { content: '\\25B6  '; font-size: 9px; }
  .obj-details[open] .obj-key::before { content: '\\25BC  '; font-size: 9px; }
  .obj-body { margin: 6px 0 4px 12px; padding-left: 10px; border-left: 2px solid var(--vscode-panel-border, #444); }

  .prim-list { display: flex; flex-direction: column; gap: 5px; }
  .prim-row  { display: flex; gap: 6px; align-items: center; }
  .prim-row input { flex: 1; }
  .btn-x {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px; flex-shrink: 0;
  }
  .btn-x:hover { color: var(--vscode-errorForeground, #f44); }

  .btn-dup, .btn-remove { background: transparent; border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .btn-dup { border: 1px solid var(--vscode-button-background, #0e639c); color: var(--vscode-button-background, #0e639c); }
  .btn-dup:hover { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  .btn-remove { border: 1px solid var(--vscode-errorForeground, #f44); color: var(--vscode-errorForeground, #f44); }
  .btn-remove:hover { background: var(--vscode-errorForeground, #f44); color: #fff; }

  .btn-add-card, .btn-add-prim {
    background: transparent; border: 1px dashed var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-background, #0e639c); border-radius: 3px; font: inherit; cursor: pointer;
  }
  .btn-add-card { display: block; width: 100%; margin-top: 6px; padding: 6px; font-size: 12px; }
  .btn-add-prim { padding: 3px 10px; font-size: 11px; margin-top: 4px; align-self: flex-start; }
  .btn-add-card:hover, .btn-add-prim:hover {
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
  }

  .toolbar { display: flex; gap: 8px; margin: -4px 0 14px; }
  .toolbar button {
    padding: 3px 12px; font: inherit; font-size: 11px; cursor: pointer; border-radius: 3px;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border, #555);
  }
  .toolbar button:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }

  .actions { display: flex; gap: 10px; margin-top: 24px; }
  #btnApply, #btnReset { padding: 7px 20px; border: none; border-radius: 3px; font: inherit; cursor: pointer; }
  #btnApply { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #btnApply:hover { background: var(--vscode-button-hoverBackground); }
  #btnReset { background: var(--vscode-button-secondaryBackground, #3a3a3a); color: var(--vscode-button-secondaryForeground, #ccc); }
  #status { margin-top: 10px; font-size: 12px; color: var(--vscode-charts-green, #4ec9b0); min-height: 16px; }
  .note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 14px; font-style: italic; }
</style>
</head>
<body>
<h2>📝 YAML Form Editor</h2>
<div class="toolbar">
  <button id="btnExpand">Expand all</button>
  <button id="btnCollapse">Collapse all</button>
</div>
<div id="form-root"></div>
<div class="actions">
  <button id="btnApply">Apply → YAML</button>
  <button id="btnReset">Reset Form</button>
</div>
<div id="status"></div>
<p class="note">Comments, blank lines and quote style are preserved. "omit" removes a field from that item only. To add new keys, edit the .yaml directly and reopen the form.</p>
<script>${script}</script>
</body>
</html>`;
}

function deactivate() {}
module.exports = { activate, deactivate, buildHtml, buildYaml, parseText };
