// Game mode icons from Films (/api/modes): one white PNG per variant icon
// index, as in Films' viewer/modeIcons.ts. The server doesn't read the
// variant's own icon index yet, so its game mode (libfilmshell's GameMode,
// match_info.game_mode) picks it, and only for modes whose icon is certain:
// Films' films pair Slayer with 0, CTF with 1 and Firefight with 19. Oddball
// (2, the skull), Infection (5) and King of the Hill (12, the crowned hill)
// are unambiguous in the art.

const BY_MODE = {
  slayer: 0, capture_the_flag: 1, oddball: 2, infection: 5, king_of_the_hill: 12,
  firefight: 19, firefight_king_of_the_hill: 19,
};

let urls;
/** Icon index to URL, fetched once. Empty when the server has no icons. */
const loadIcons = () => urls ??= fetch('/api/modes')
  .then(response => response.ok ? response.json() : null)
  .then(index => new Map((index?.icons ?? []).map(icon => [icon.index, icon.url])))
  .catch(() => new Map());

/** The icon index for a game mode, or null when it isn't known for certain. */
const modeIconIndex = gameMode => BY_MODE[gameMode] ?? null;

/** A mode's icon, `size` px square and decorative (the mode's name stands
 *  next to it). A known mode keeps its space while the image loads, so the
 *  name beside it never shifts. An unknown one is hidden and takes none. */
export function modeIcon(gameMode, size = 14) {
  const img = document.createElement('img');
  img.className = 'mode-icon';
  img.alt = '';
  img.decoding = 'async';
  img.width = img.height = size;
  const index = modeIconIndex(gameMode);
  if (index === null) { img.hidden = true; return img; }
  img.style.visibility = 'hidden';
  void loadIcons().then(map => {
    const url = map.get(index);
    if (url) { img.src = url; img.style.visibility = ''; } else img.hidden = true;
  });
  return img;
}
