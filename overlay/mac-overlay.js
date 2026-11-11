// Meet Comment Overlay for macOS.
// Runs on JXA (osascript), which ships with macOS, so nothing has to be installed:
//   osascript -l JavaScript overlay/mac-overlay.js [screenIndex] [port]
// Draws a transparent, click-through window over the whole screen and flows the comments and
// reactions that the Chrome extension sends to http://127.0.0.1:<port>/event.

ObjC.import('Cocoa');
ObjC.import('WebKit');

const DEFAULT_PORT = 39393;
const MAX_BODY = 256 * 1024;

function log(msg) {
  const line = $.NSString.alloc.initWithUTF8String('[overlay] ' + msg + '\n');
  $.NSFileHandle.fileHandleWithStandardError.writeData(line.dataUsingEncoding($.NSUTF8StringEncoding));
}

function scriptDir() {
  // The path osascript was given; resolve it against the current directory.
  const args = $.NSProcessInfo.processInfo.arguments;
  for (let i = 0; i < args.count; i++) {
    const a = ObjC.unwrap(args.objectAtIndex(i));
    if (/mac-overlay\.js$/.test(a)) {
      const p = $(a).stringByStandardizingPath;
      const abs = p.isAbsolutePath ? p : $.NSFileManager.defaultManager.currentDirectoryPath.stringByAppendingPathComponent(p);
      return ObjC.unwrap(abs.stringByStandardizingPath.stringByDeletingLastPathComponent);
    }
  }
  return ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
}

// ---------- HTTP (tiny, loopback only) ----------

function sockaddrLoopback(port) {
  // struct sockaddr_in { len=16, family=AF_INET, port (big endian), addr=127.0.0.1, zero[8] }
  const bytes = [16, 2, (port >> 8) & 0xff, port & 0xff, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // base64 without btoa (not available in JXA)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const n = (bin.charCodeAt(i) << 16) | ((bin.charCodeAt(i + 1) || 0) << 8) | (bin.charCodeAt(i + 2) || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] +
      (i + 1 < bin.length ? chars[(n >> 6) & 63] : '=') + (i + 2 < bin.length ? chars[n & 63] : '=');
  }
  return $.NSData.alloc.initWithBase64EncodedStringOptions(out, 0);
}

function utf8(data) {
  const s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return s.isNil() ? '' : ObjC.unwrap(s);
}

function latin1(data) {
  const s = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
  return s.isNil() ? '' : ObjC.unwrap(s);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store',
};

function respond(conn, status, contentType, body) {
  const bodyData = typeof body === 'string' ? $(body).dataUsingEncoding($.NSUTF8StringEncoding) : body;
  const reason = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 404: 'Not Found', 413: 'Payload Too Large' }[status] || 'OK';
  let head = 'HTTP/1.1 ' + status + ' ' + reason + '\r\n';
  const headers = Object.assign({}, CORS, { 'Content-Length': String(bodyData.length), Connection: 'close' });
  if (contentType) headers['Content-Type'] = contentType;
  for (const k in headers) head += k + ': ' + headers[k] + '\r\n';
  head += '\r\n';
  const out = $.NSMutableData.dataWithData($(head).dataUsingEncoding($.NSUTF8StringEncoding));
  out.appendData(bodyData);
  try {
    conn.writeData(out);
  } catch (e) {
    // the client went away
  }
  conn.closeFile;
}

// ---------- App ----------

const state = {
  dir: null,
  port: DEFAULT_PORT,
  windows: [],
  webViews: [],
  paused: false,
  listener: null,
  buffers: {}, // connection key -> NSMutableData
  conns: {},
  nextConnKey: 1,
  counts: { comments: 0, reactions: 0 },
  statusItem: null,
  navLog: [],
  diags: [],
  screenChoice: 0, // screen index, or -1 for every screen
  recent: [], // last comments with their source, for GET /log
};

function navNote(msg) {
  state.navLog.push(new Date().toLocaleTimeString('ja-JP') + ' ' + msg);
  log(msg);
}

function pushToOverlay(events) {
  if (state.paused) return;
  // `void` keeps the result undefined. Pass a function, not null: JXA crashes calling a null block.
  const js = 'void (window.nico && window.nico.push(' + JSON.stringify(events) + '))';
  for (const wv of state.webViews) wv.evaluateJavaScriptCompletionHandler(js, function () {});
}

function handleEvents(events) {
  if (!Array.isArray(events)) events = [events];
  const clean = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'comment' && typeof e.text === 'string' && e.text.trim()) {
      state.recent.push({ at: new Date().toLocaleTimeString('ja-JP'), text: e.text.slice(0, 200), author: e.author || '', source: e.source || '' });
      if (state.recent.length > 50) state.recent.shift();
      const comment = { type: 'comment', text: e.text.slice(0, 500), author: typeof e.author === 'string' ? e.author.slice(0, 80) : '' };
      // display settings chosen in the extension popup travel with each comment
      if (e.fontScale >= 0.3 && e.fontScale <= 4) comment.fontScale = e.fontScale;
      if (e.seconds >= 1 && e.seconds <= 60) comment.seconds = e.seconds;
      clean.push(comment);
      state.counts.comments++;
    } else if (e.type === 'reaction' && typeof e.emoji === 'string' && e.emoji.trim()) {
      clean.push({ type: 'reaction', emoji: e.emoji.slice(0, 16), count: Math.min(50, Math.max(1, e.count | 0)) });
      state.counts.reactions++;
    } else if (e.type === 'diag' && e.report) {
      // Self-diagnosis from the extension (a chat message containing "#nicotest"); see GET /diag.
      state.diags.push({ at: new Date().toLocaleTimeString('ja-JP'), report: e.report });
      if (state.diags.length > 30) state.diags.shift();
      log('診断情報を受け取りました: http://127.0.0.1:' + state.port + '/diag');
    }
  }
  if (clean.length) {
    pushToOverlay(clean);
    updateStatusTitle();
  }
  return clean.length;
}

function handleRequest(conn, method, path, body) {
  path = path.split('?')[0];
  if (method === 'OPTIONS') return respond(conn, 204, null, '');
  if (method === 'GET' && path === '/ping') {
    return respond(conn, 200, 'application/json', JSON.stringify({ ok: true, app: 'meet-comment-overlay', paused: state.paused, counts: state.counts }));
  }
  if (method === 'GET' && path === '/screens') {
    return respond(conn, 200, 'application/json', JSON.stringify({ ok: true, screens: screenList(), current: state.screenChoice, allowAll: true }));
  }
  if (method === 'POST' && path === '/screen') {
    let index;
    try {
      index = JSON.parse(body).index;
    } catch (e) {}
    if (!Number.isInteger(index) || index < -1 || index >= $.NSScreen.screens.count) {
      return respond(conn, 400, 'application/json', JSON.stringify({ ok: false, error: 'invalid screen' }));
    }
    showOn(index);
    saveSettings();
    return respond(conn, 200, 'application/json', JSON.stringify({ ok: true, screens: screenList(), current: state.screenChoice, allowAll: true }));
  }
  if (method === 'GET' && path === '/log') {
    return respond(conn, 200, 'application/json', JSON.stringify(state.recent, null, 2));
  }
  if (method === 'GET' && path === '/diag') {
    return respond(conn, 200, 'application/json', JSON.stringify(state.diags, null, 2));
  }
  if (method === 'GET' && path === '/debug') {
    const views = state.webViews.map((v, i) => ({
      title: ObjC.unwrap(v.title) || '',
      loading: !!v.isLoading,
      window: (() => {
        const w = state.windows[i];
        const f = w.frame;
        return { visible: !!w.isVisible, onActiveSpace: !!w.isOnActiveSpace, level: w.level, frame: [f.origin.x, f.origin.y, f.size.width, f.size.height] };
      })(),
    }));
    return respond(conn, 200, 'application/json', JSON.stringify({ paused: state.paused, counts: state.counts, navigation: state.navLog.slice(-10), views }, null, 2));
  }
  if (method === 'GET' && (path === '/' || path === '/test' || path === '/test.html')) {
    const file = $.NSData.dataWithContentsOfFile(state.dir + '/test.html');
    if (file.isNil()) return respond(conn, 404, 'text/plain', 'test.html not found');
    return respond(conn, 200, 'text/html; charset=utf-8', file);
  }
  if (method === 'POST' && path === '/event') {
    let events;
    try {
      events = JSON.parse(body);
    } catch (e) {
      return respond(conn, 400, 'application/json', JSON.stringify({ ok: false, error: 'invalid JSON' }));
    }
    const n = handleEvents(events);
    return respond(conn, 200, 'application/json', JSON.stringify({ ok: true, accepted: n, paused: state.paused }));
  }
  return respond(conn, 404, 'text/plain', 'not found');
}

// Returns true when the request is complete and has been answered.
function tryHandle(conn, data) {
  const text = latin1(data);
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (data.length > 16 * 1024) { respond(conn, 413, 'text/plain', 'headers too large'); return true; }
    return false;
  }
  const lines = text.slice(0, headerEnd).split('\r\n');
  const [method, path] = lines[0].split(' ');
  let length = 0;
  for (const line of lines.slice(1)) {
    const m = /^content-length:\s*(\d+)/i.exec(line);
    if (m) length = parseInt(m[1], 10);
  }
  if (length > MAX_BODY) { respond(conn, 413, 'text/plain', 'too large'); return true; }
  const bodyStart = headerEnd + 4;
  if (data.length < bodyStart + length) return false;
  const body = length ? utf8(data.subdataWithRange($.NSMakeRange(bodyStart, length))) : '';
  try {
    handleRequest(conn, method, path || '/', body);
  } catch (e) {
    log('request error: ' + e);
    respond(conn, 400, 'text/plain', 'error');
  }
  return true;
}

ObjC.registerSubclass({
  name: 'MCOController',
  protocols: ['WKNavigationDelegate'],
  methods: {
    'webView:didFinishNavigation:': {
      types: ['void', ['id', 'id']],
      implementation: function () {
        navNote('overlay.html を読み込みました');
      },
    },
    'webView:didFailNavigation:withError:': {
      types: ['void', ['id', 'id', 'id']],
      implementation: function (view, nav, error) {
        navNote('読み込み失敗: ' + ObjC.unwrap(error.localizedDescription));
      },
    },
    'webView:didFailProvisionalNavigation:withError:': {
      types: ['void', ['id', 'id', 'id']],
      implementation: function (view, nav, error) {
        navNote('読み込み失敗: ' + ObjC.unwrap(error.localizedDescription));
      },
    },
    'webViewWebContentProcessDidTerminate:': {
      types: ['void', ['id']],
      implementation: function (view) {
        navNote('描画プロセスが終了したので再読み込みします');
        view.reload;
      },
    },
    'accepted:': {
      types: ['void', ['id']],
      implementation: function (notif) {
        const conn = notif.userInfo.objectForKey($.NSFileHandleNotificationFileHandleItem);
        state.listener.acceptConnectionInBackgroundAndNotify;
        if (!conn || conn.isNil()) return;
        const key = String(state.nextConnKey++);
        state.buffers[key] = $.NSMutableData.data;
        state.conns[key] = conn;
        $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
          controller, 'readData:', $.NSFileHandleReadCompletionNotification, conn);
        conn.readInBackgroundAndNotify;
      },
    },
    'readData:': {
      types: ['void', ['id']],
      implementation: function (notif) {
        const conn = notif.object;
        let key = null;
        for (const k in state.conns) if (state.conns[k].isEqual(conn)) { key = k; break; }
        if (!key) return;
        const chunk = notif.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
        const done = () => {
          $.NSNotificationCenter.defaultCenter.removeObserverNameObject(controller, $.NSFileHandleReadCompletionNotification, conn);
          delete state.conns[key];
          delete state.buffers[key];
        };
        if (!chunk || chunk.isNil() || chunk.length === 0) { conn.closeFile; done(); return; }
        const buf = state.buffers[key];
        buf.appendData(chunk);
        if (buf.length > MAX_BODY + 16 * 1024) { respond(conn, 413, 'text/plain', 'too large'); done(); return; }
        if (tryHandle(conn, buf)) { done(); return; }
        conn.readInBackgroundAndNotify;
      },
    },
    'screensChanged:': {
      types: ['void', ['id']],
      implementation: function () {
        showOn(state.screenChoice === -1 ? -1 : savedScreenChoice());
      },
    },
    'testComment:': {
      types: ['void', ['id']],
      implementation: function () {
        handleEvents([
          { type: 'comment', text: 'テストコメント ' + new Date().toLocaleTimeString('ja-JP') },
          { type: 'reaction', emoji: '👏', count: 3 },
          { type: 'reaction', emoji: '💖' },
          { type: 'reaction', emoji: '😂' },
        ]);
      },
    },
    'togglePause:': {
      types: ['void', ['id']],
      implementation: function (sender) {
        state.paused = !state.paused;
        for (const w of state.windows) {
          if (state.paused) w.orderOut(null);
          else w.orderFrontRegardless;
        }
        sender.state = state.paused ? 1 : 0;
        updateStatusTitle();
      },
    },
    'openTestPage:': {
      types: ['void', ['id']],
      implementation: function () {
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString('http://127.0.0.1:' + state.port + '/'));
      },
    },
    'quit:': {
      types: ['void', ['id']],
      implementation: function () {
        $.NSApplication.sharedApplication.terminate(null);
      },
    },
  },
});
const controller = $.MCOController.alloc.init;

// The same picture as the button in Meet: a screen with a speech bubble; struck through while paused.
// Drawn in the button's 24 x 24 SVG coordinates (y down), scaled to an 18 pt menu bar image.
function statusIcon(paused) {
  const side = 18;
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(side, side));
  img.lockFocus;
  const t = $.NSAffineTransform.transform;
  t.translateXByYBy(0, side);
  t.scaleXByYBy(side / 24, -side / 24);
  t.concat;
  $.NSColor.blackColor.set;
  const stroke = (path, width) => {
    path.lineWidth = width;
    path.lineCapStyle = 1; // round
    path.lineJoinStyle = 1;
    path.stroke;
  };
  stroke($.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(2.5, 4, 19, 13), 2, 2), 1.8);
  const stand = $.NSBezierPath.bezierPath;
  stand.moveToPoint($.NSMakePoint(8.5, 20.5));
  stand.lineToPoint($.NSMakePoint(15.5, 20.5));
  stand.moveToPoint($.NSMakePoint(12, 17));
  stand.lineToPoint($.NSMakePoint(12, 20.5));
  stroke(stand, 1.8);
  const bubble = $.NSBezierPath.bezierPath; // M7.5 7.5h9v5h-5l-2.2 1.9v-1.9H7.5z
  bubble.moveToPoint($.NSMakePoint(7.5, 7.5));
  bubble.lineToPoint($.NSMakePoint(16.5, 7.5));
  bubble.lineToPoint($.NSMakePoint(16.5, 12.5));
  bubble.lineToPoint($.NSMakePoint(11.5, 12.5));
  bubble.lineToPoint($.NSMakePoint(9.3, 14.4));
  bubble.lineToPoint($.NSMakePoint(9.3, 12.5));
  bubble.lineToPoint($.NSMakePoint(7.5, 12.5));
  bubble.closePath;
  bubble.fill;
  if (paused) {
    const slash = $.NSBezierPath.bezierPath;
    slash.moveToPoint($.NSMakePoint(3, 2.5));
    slash.lineToPoint($.NSMakePoint(21, 21.5));
    stroke(slash, 2);
  }
  img.unlockFocus;
  img.template = true; // macOS tints it for light and dark menu bars
  return img;
}

function updateStatusTitle() {
  if (!state.statusItem) return;
  if (state.iconPaused !== state.paused) {
    state.iconPaused = state.paused;
    state.statusItem.button.title = '';
    state.statusItem.button.image = statusIcon(state.paused);
  }
  state.statusItem.button.toolTip = 'Meet Comment Overlay  コメント ' + state.counts.comments + ' / リアクション ' + state.counts.reactions;
}

// BSD sockets through the JXA bridge: NSSocketPort cannot tell us when bind() fails.
ObjC.bindFunction('socket', ['int', ['int', 'int', 'int']]);
ObjC.bindFunction('setsockopt', ['int', ['int', 'int', 'int', 'void *', 'unsigned int']]);
ObjC.bindFunction('bind', ['int', ['int', 'void *', 'unsigned int']]);
ObjC.bindFunction('listen', ['int', ['int', 'int']]);
ObjC.bindFunction('close', ['int', ['int']]);

/** True when another copy of this overlay already answers on the port. */
function overlayAlreadyRunning(port) {
  const url = $.NSURL.URLWithString('http://127.0.0.1:' + port + '/ping');
  const body = $.NSString.stringWithContentsOfURLEncodingError(url, $.NSUTF8StringEncoding, null);
  return !body.isNil() && ObjC.unwrap(body).indexOf('meet-comment-overlay') >= 0;
}

function startServer(port) {
  const AF_INET = 2, SOCK_STREAM = 1, IPPROTO_TCP = 6, SOL_SOCKET = 0xffff, SO_REUSEADDR = 4;
  const fd = $.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (fd < 0) return false;
  // SO_REUSEADDR: restarting right after quitting must not wait for TIME_WAIT to clear.
  const one = $.NSData.alloc.initWithBase64EncodedStringOptions('AQAAAA==', 0); // int 1
  $.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, one.bytes, 4);
  const addr = sockaddrLoopback(port);
  if ($.bind(fd, addr.bytes, 16) !== 0 || $.listen(fd, 32) !== 0) {
    $.close(fd);
    return false;
  }
  state.listener = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(fd, true);
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
    controller, 'accepted:', $.NSFileHandleConnectionAcceptedNotification, state.listener);
  state.listener.acceptConnectionInBackgroundAndNotify;
  return true;
}

// ---------- which screen ----------

function screenList() {
  const screens = $.NSScreen.screens;
  const out = [];
  for (let i = 0; i < screens.count; i++) {
    const sc = screens.objectAtIndex(i);
    let name = '';
    try {
      name = ObjC.unwrap(sc.localizedName) || '';
    } catch (e) {}
    out.push({ index: i, name: name || '画面 ' + (i + 1), width: Math.round(sc.frame.size.width), height: Math.round(sc.frame.size.height), main: i === 0 });
  }
  return out;
}

/** Shows the overlay on screen `choice` (index), or on every screen for -1. */
function showOn(choice) {
  for (const w of state.windows) {
    w.orderOut(null);
    w.close;
  }
  state.windows = [];
  state.webViews = [];
  const screens = $.NSScreen.screens;
  if (choice !== -1 && !(choice >= 0 && choice < screens.count)) choice = 0;
  state.screenChoice = choice;
  if (choice === -1) {
    for (let i = 0; i < screens.count; i++) createOverlay(screens.objectAtIndex(i));
  } else {
    createOverlay(screens.objectAtIndex(choice));
  }
  if (state.paused) for (const w of state.windows) w.orderOut(null);
}

// The choice is remembered next to this script (by name too, in case the order changes).
function settingsPath() {
  return state.dir + '/.overlay-settings.json';
}

function saveSettings() {
  const list = screenList();
  const chosen = list[state.screenChoice];
  const json = JSON.stringify({ screen: state.screenChoice, screenName: chosen ? chosen.name : '' });
  $(json).writeToFileAtomicallyEncodingError(settingsPath(), true, $.NSUTF8StringEncoding, null);
}

function savedScreenChoice() {
  const text = $.NSString.stringWithContentsOfFileEncodingError(settingsPath(), $.NSUTF8StringEncoding, null);
  if (text.isNil()) return 0;
  try {
    const saved = JSON.parse(ObjC.unwrap(text));
    if (saved.screen === -1) return -1;
    const list = screenList();
    const byName = saved.screenName ? list.find((sc) => sc.name === saved.screenName) : null;
    if (byName) return byName.index;
    return Number.isInteger(saved.screen) && saved.screen >= 0 && saved.screen < list.length ? saved.screen : 0;
  } catch (e) {
    return 0;
  }
}

function createOverlay(screen) {
  const frame = screen.frame;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.opaque = false;
  win.backgroundColor = $.NSColor.clearColor;
  win.hasShadow = false;
  win.ignoresMouseEvents = true;
  win.releasedWhenClosed = false;
  // Above full-screen apps (Keynote, PowerPoint, browser full screen) and on every Space.
  win.level = 1000; // NSScreenSaverWindowLevel
  win.collectionBehavior = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8); // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
  win.setFrameDisplay(frame, true);

  const config = $.WKWebViewConfiguration.alloc.init;
  const view = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, frame.size.width, frame.size.height), config);
  view.setValueForKey($.NSNumber.numberWithBool(false), 'drawsBackground');
  view.autoresizingMask = 18; // width + height sizable
  win.contentView = view;

  // Keep comments out of the notch / menu bar strip.
  let top = 0;
  try {
    const insets = screen.safeAreaInsets;
    if (insets && insets.top) top = Math.round(insets.top);
  } catch (e) {}
  if (!top) top = Math.max(0, Math.round(frame.size.height - screen.visibleFrame.size.height - (screen.visibleFrame.origin.y - frame.origin.y)));
  top = Math.min(top, 48) + 6;

  // Load the page as a string with the settings injected (no file:// access rules involved).
  const html = $.NSString.stringWithContentsOfFileEncodingError(state.dir + '/overlay.html', $.NSUTF8StringEncoding, null);
  if (html.isNil()) {
    log('overlay.html を読み込めませんでした: ' + state.dir + '/overlay.html');
    return;
  }
  const settings = '<script>window.OVERLAY_CONFIG = ' + JSON.stringify({ top: top }) + ';</script>';
  const page = ObjC.unwrap(html).replace('<head>', '<head>' + settings);
  view.navigationDelegate = controller;
  view.loadHTMLStringBaseURL(page, $.NSURL.fileURLWithPath(state.dir + '/'));
  win.orderFrontRegardless;
  state.windows.push(win);
  state.webViews.push(view);
}

function setupStatusItem() {
  const item = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
  const menu = $.NSMenu.alloc.initWithTitle('Meet Comment Overlay');
  const add = (title, action, key) => {
    const mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, key || '');
    mi.target = controller;
    menu.addItem(mi);
    return mi;
  };
  const header = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent('Meet Comment Overlay (port ' + state.port + ')', null, '');
  header.enabled = false;
  menu.addItem(header);
  menu.addItem($.NSMenuItem.separatorItem);
  add('テストコメントを流す', 'testComment:');
  add('テスト送信ページを開く', 'openTestPage:');
  add('一時停止', 'togglePause:');
  menu.addItem($.NSMenuItem.separatorItem);
  add('終了', 'quit:', 'q');
  item.menu = menu;
  state.statusItem = item;
  updateStatusTitle();
}

function run(argv) {
  state.dir = scriptDir();
  const screenArg = argv && argv[0] !== undefined && argv[0] !== '' ? parseInt(argv[0], 10) : NaN;
  if (argv && argv[1]) state.port = parseInt(argv[1], 10) || DEFAULT_PORT;

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  if (overlayAlreadyRunning(state.port)) {
    log('オーバーレイはすでに起動しています（ポート ' + state.port + '）。メニューバーのアイコン（モニターに吹き出し）から操作してください。');
    return;
  }
  if (!startServer(state.port)) {
    log('ポート ' + state.port + ' を開けませんでした。ほかのアプリが使っていないか確認してください。');
    return;
  }

  const screens = $.NSScreen.screens;
  // A screen given on the command line wins; otherwise the one chosen last time (extension popup).
  const fromArg = Number.isInteger(screenArg) && screenArg >= -1 && screenArg < screens.count;
  showOn(fromArg ? screenArg : savedScreenChoice());
  // Displays plugged in or removed: keep the choice if it still exists, else the main screen.
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
    controller, 'screensChanged:', $.NSApplicationDidChangeScreenParametersNotification, null);
  setupStatusItem();

  log('起動しました: http://127.0.0.1:' + state.port + '/  (画面数 ' + screens.count + ', 表示中 ' + state.windows.length + ')');
  log('終了するにはメニューバーのアイコン（モニターに吹き出し）→ 終了、またはこのウィンドウで Ctrl+C');
  app.run;
}
