// The saved look and theme apply before first paint, so a reload never flashes the default. A file,
// not an inline script, so the board's hash-based Content Security Policy lets it run. The keys and
// looks mirror LOOK_KEY and LOOKS (src/lib/state/look.svelte.ts) and THEME_KEY (routes/+layout.svelte).
try {
  var look = localStorage.getItem('officina.look');
  if (look === 'modernista' || look === 'tecnica') document.documentElement.dataset.look = look;
  var theme = localStorage.getItem('officina.theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
} catch (error) {}
