# iina-edl-skip

An [IINA](https://iina.io) plugin that skips recaps, intros and closing credits
automatically, reading the same `.edl` sidecar files that Kodi uses.

Kodi reads `<video>.edl` next to an episode and skips the marked ranges on its
own. mpv-based players do not: mpv has its own unrelated "EDL" format for
stitching clips into a timeline, and it never looks for a sidecar. This plugin
fills that gap, so a library already marked up for Kodi plays the same way in
IINA — no second database of timings, nothing to keep in sync.

## Behaviour

- Segments are skipped silently, the way Kodi does it. There is no button to press.
- **Each segment is skipped at most once per playback.** Rewinding back into a
  segment you already skipped plays it normally, so the player never fights you.
- Seeks are frame-exact, not keyframe-aligned — an intro does not leave a second
  or two of itself on screen.
- Network streams are ignored entirely; the plugin only touches local files.
- State is per file. Opening another episode starts over.
- When there is no sidecar, Matroska chapters named Recap, Intro or Credits are
  used instead. A sidecar, when present, always wins.
- **Undo Last Skip** (⌥⌘Z, also in the plugin menu) returns to where playback
  was when the last segment was skipped, without skipping it again.
- An **EDL** tab in the sidebar lists the segments of the current file, marks
  the ones already skipped, and jumps to one when you click it.

## Install

**From GitHub.** IINA → Settings → Plugins → *Install from GitHub*, then enter:

```
BaldPanther/iina-edl-skip
```

The plugin asks for two permissions: `file-system` to read the sidecar next to
the video, and `show-osd` for the notification.

**From source, for development:**

```sh
git clone https://github.com/BaldPanther/iina-edl-skip.git
/Applications/IINA.app/Contents/MacOS/iina-plugin link iina-edl-skip
```

Then enable the plugin in IINA → Settings → Plugins. `iina-plugin unlink` removes
the link again.

`./pack.sh` builds the `.iinaplgz` archive for a release. It exists because
`iina-plugin pack` only accepts a folder named `*.iinaplugin` and archives
everything inside it, `.git` included.

## The `.edl` format

Three tab-separated fields per line — start, end, action — with times in seconds.
Lines starting with `##` are markers:

```
## Recap
0.000	42.000	3
## Intro
42.000	102.000	3
## Outro / Credits
3300.000	3533.000	3
```

Action `3` is Kodi's *commercial break*: skip once, but allow rewinding back in.
Action `0` (*cut*) is treated the same way. Actions `1` (mute) and `2` (scene
marker) are not skips and are ignored.

The sidecar is the video's name with the extension replaced by `.edl`, so
`Show - S01E02 - Name.mkv` pairs with `Show - S01E02 - Name.edl`. Any of the
three sections may be missing.

Clock times (`00:01:42.000`) are accepted as well, for hand-written files.

Sidecars written by [media-toolkit](https://github.com/BaldPanther/media-toolkit)
always carry the `##` markers. Files from elsewhere usually do not, and their
segments are classified by position instead: one starting at zero counts as a
recap, the last one as credits, anything in between as an intro.

## Settings

IINA → Settings → Plugins → EDL Skip.

| Setting | Default | |
|---|---|---|
| Skip segments automatically | on | Master switch, also in the plugin menu (⌥⌘E) |
| Recap / Intro / Credits | all on | Which kinds of segment to act on |
| Fall back to chapters | on | Used only when no sidecar is found |
| When a segment runs to the end of the file | Skip anyway | See below |
| Show a notification | on | Brief OSD message naming what was skipped |

Closing credits are normally marked all the way to the end of the file, so
skipping them ends playback — which is what Kodi does, and the default here. The
two alternatives are going to the next item in the playlist, or leaving such a
segment alone so the credits play out.

## Requirements

IINA 1.4 or newer. No build step, no dependencies — the plugin is plain
JavaScript running in IINA's JavaScriptCore engine.

## Tests

```sh
./tests/run.sh
```

`parser.test.js` covers the `.edl` parsing, `behaviour.test.js` drives the
skipping itself against a stub of IINA's API — including the parts that cannot
be reached from outside, since a plugin's key binding is a Cocoa menu
equivalent that mpv's IPC cannot trigger. Both run on the JavaScriptCore that
ships with macOS, through `osascript -l JavaScript`, so there is nothing to
install.

## License

MIT. See [LICENSE](LICENSE).

---

## По-русски

Плагин для IINA, пропускающий заставки по файлам `.edl` — тем самым, что читает
Kodi.

Kodi берёт `<видео>.edl` рядом с серией и сам перескакивает размеченные куски.
Плееры на mpv так не умеют: у mpv есть свой формат с тем же названием, но он про
склейку кусков в общий таймлайн, и сайдкар рядом с видео mpv не ищет вовсе. Этот
плагин закрывает дыру — медиатека, размеченная для Kodi, ведёт себя в IINA
точно так же, и второй базы таймингов заводить не нужно.

**Как себя ведёт.** Пропускает молча, без кнопок. Каждый сегмент — не больше
одного раза за просмотр: отмотал назад в уже пропущенное интро, и плеер не
выбрасывает тебя вперёд снова. Перемотка точная, а не по опорным кадрам, иначе
от заставки оставался бы хвост в секунду-две. Сетевые источники не трогает.

**Установка.** IINA → Настройки → Plugins → *Install from GitHub*, указать
`BaldPanther/iina-edl-skip`. Плагин просит два разрешения: `file-system` —
прочитать сайдкар рядом с видео, `show-osd` — показать уведомление.

**Настройки.** Общий выключатель (он же в меню плагина), отдельные галки на
Recap / Intro / Credits, поведение на титрах и короткое уведомление.

Титры в наших `.edl` почти всегда размечены до самого конца файла, поэтому их
пропуск завершает воспроизведение — так делает Kodi, так же по умолчанию делаем
и мы. Если это мешает, в настройках есть «перейти к следующему в плейлисте» и
«не трогать, дать титрам доиграть».

Файлы `.edl` пишет [media-toolkit](https://github.com/BaldPanther/media-toolkit); его
разметка всегда с маркерами `##`. Чужие файлы обычно без них — тогда сегменты
раскладываются по положению: начинающийся с нуля считается recap, последний —
титрами, остальные — интро.

**Если сайдкара нет**, в дело идут главы Matroska с именами Recap, Intro или
Credits — их пишет тот же `media-toolkit`. Главы едут внутри файла и переживают
переезд, который оставил `.edl` позади. Сайдкар, когда он есть, всегда главнее.

**⌥⌘Z отменяет последний пропуск** — возвращает туда, откуда только что
выбросило, и повторно уже не выбрасывает. ⌥⌘E включает и выключает авто-пропуск.

**Вкладка EDL в боковой панели** показывает сегменты текущего файла, отмечает
уже пропущенные и прыгает к сегменту по клику.
