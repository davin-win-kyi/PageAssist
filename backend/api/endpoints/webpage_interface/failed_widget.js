/*
The following file is the widget shown when generating the widget fails
- a red warning with the error, so the user knows to try again from the side panel
*/
window.render = function (state) {
  document.body.style.cssText =
    'box-sizing:border-box;margin:0;padding:12px 14px;background:#fdecea;border:2px solid #d93025;' +
    'border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#7f1d1d;';
  document.body.innerHTML = '';

  var title = document.createElement('div');
  title.style.cssText = 'font-weight:700;color:#b3261e;margin-bottom:6px;';
  title.textContent = '⚠ ' + (state.title || 'PageAssist could not build your support');
  document.body.appendChild(title);

  var hint = document.createElement('div');
  hint.style.cssText = 'margin-bottom:6px;';
  hint.textContent = 'Try again from the PageAssist side panel.';
  document.body.appendChild(hint);

  if (state.error) {
    var error = document.createElement('div');
    error.style.cssText = 'font:11px ui-monospace,Menlo,monospace;color:#7f1d1d;opacity:0.8;word-break:break-word;';
    error.textContent = state.error;
    document.body.appendChild(error);
  }
};
