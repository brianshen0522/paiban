import { t } from '../copy/zh-TW';
import { setTheme, type ThemeChoice, useTheme } from '../lib/theme';

const CHOICES: ThemeChoice[] = ['light', 'dark', 'system'];

/** Light, dark or the system's setting (Brian, 2026-10-06). A radio group, so arrow keys work. */
export function ThemePicker() {
  const current = useTheme();
  return (
    <fieldset className="seg">
      <legend>{t.theme.label}</legend>
      {CHOICES.map((c) => (
        <label key={c} className={current === c ? 'on' : ''}>
          <input type="radio" name="paiban-theme" value={c} checked={current === c} onChange={() => setTheme(c)} />
          {t.theme[c]}
        </label>
      ))}
    </fieldset>
  );
}
