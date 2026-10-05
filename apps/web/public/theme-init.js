// Applies the saved theme before the first paint (see src/lib/theme.ts). Kept as a file, not
// inline, because the Content-Security-Policy allows scripts from this site only.
try {
  var v = localStorage.getItem('paiban.theme');
  if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
} catch (e) {}
