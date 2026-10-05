/* The three ways a downloaded subtitle is typically wrong. Each distorts the correctly timed demo subtitle. */
(function (root) {
  var S = [
    { id: 'late', label: '整體慢 2.4 秒', hint: '這份字幕全片固定晚 2.4 秒出現,是最常見的情況。', f: function (t) { return t + 2.4; } },
    { id: 'rate', label: '影格率不同,越後面越不準', hint: '這份字幕是照 25 fps 的版本做的,影片是 23.976 fps:開頭只差一點,片尾差到快 4 秒。', f: function (t) { return t * (23.976 / 25) + 0.8; } },
    { id: 'cut', label: '剪輯版本不同,中段多一場戲', hint: '這份字幕的版本少了中間一段 13 秒沒有對白的戲,所以前半差 1.2 秒、後半差 13.2 秒。', f: function (t, i) { return i < 13 ? t - 1.2 : t - 13.2; } }
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = S; else root.SCENARIOS = S;
})(typeof window !== 'undefined' ? window : this);
