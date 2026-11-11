const STORAGE_KEY = 'word-shapes-appearance';
const PALETTES = new Set(['classic', 'ocean', 'sunset', 'solid']);
const THEMES = new Set(['system', 'light', 'dark']);
const DEFAULTS = { palette: 'classic', color: '#639182', theme: 'system' };

function validColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function contrastColor(color) {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

export function setupAppearance({ onChange } = {}) {
  const root = document.documentElement;
  const paletteInput = document.getElementById('piece-palette');
  const colorInput = document.getElementById('piece-color');
  const colorField = document.getElementById('solid-color-field');
  const themeInput = document.getElementById('site-theme');
  const darkPreference = window.matchMedia?.('(prefers-color-scheme: dark)');
  const state = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (PALETTES.has(saved?.palette)) state.palette = saved.palette;
    if (validColor(saved?.color)) state.color = saved.color.toLowerCase();
    if (THEMES.has(saved?.theme)) state.theme = saved.theme;
  } catch { /* Appearance remains available when browser storage is restricted. */ }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { /* The current selection still applies without storage. */ }
  }

  function applyTheme() {
    const dark = state.theme === 'dark' || (state.theme === 'system' && darkPreference?.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17201d' : '#f8f7f2');
    themeInput.value = state.theme;
  }

  function applyColors() {
    root.dataset.palette = state.palette;
    root.style.setProperty('--solid-color', state.color);
    root.style.setProperty('--solid-contrast', contrastColor(state.color));
    paletteInput.value = state.palette;
    colorInput.value = state.color;
    colorField.hidden = state.palette !== 'solid';
  }

  function getAppearance() {
    return state.palette === 'solid' ? { palette: state.palette, color: state.color } : { palette: state.palette };
  }

  function setAppearance(value, { persist: save = true, notify = false } = {}) {
    if (!value || !PALETTES.has(value.palette)) return;
    state.palette = value.palette;
    if (validColor(value.color)) state.color = value.color.toLowerCase();
    applyColors();
    if (save) persist();
    if (notify) onChange?.(getAppearance());
  }

  paletteInput.addEventListener('change', () => setAppearance({ palette: paletteInput.value }, { notify: true }));
  colorInput.addEventListener('input', () => setAppearance({ palette: 'solid', color: colorInput.value }));
  colorInput.addEventListener('change', () => setAppearance({ palette: 'solid', color: colorInput.value }, { notify: true }));
  themeInput.addEventListener('change', () => {
    if (!THEMES.has(themeInput.value)) return;
    state.theme = themeInput.value;
    applyTheme();
    persist();
  });
  const updateSystemTheme = () => { if (state.theme === 'system') applyTheme(); };
  if (darkPreference?.addEventListener) darkPreference.addEventListener('change', updateSystemTheme);
  else darkPreference?.addListener?.(updateSystemTheme);
  applyColors();
  applyTheme();
  return { getAppearance, setAppearance };
}
