/*
Webpage interface model in the case that a call fails
*/
window.render = function (state) {
  document.body.style.cssText =
    'box-sizing:border-box;padding:12px;background:#ffffff;border:1px solid #e0e0e0;' +
    'border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#111;';
  document.body.innerHTML = '';

  var note = document.createElement('div');
  note.style.cssText = 'font-weight:600;margin-bottom:8px;';
  note.textContent = state.note || 'Available page elements';
  document.body.appendChild(note);

  (state.items || []).forEach(function (item) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:2px 0;';
    row.textContent = (item.complete ? '✓ ' : '○ ') + item.label;
    document.body.appendChild(row);
  });
};
