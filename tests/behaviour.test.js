/*
 * Behaviour tests for the skipping state machine in index.js.
 *
 * Where parser.test.js checks pure functions, this drives the real flow: a
 * stub `iina` records the mpv commands the plugin issues and applies the seeks
 * back to the fake playback position, so a test can watch a file play through.
 *
 * This exists because a plugin's keyBinding is a Cocoa menu equivalent, not an
 * mpv binding — mpv's IPC `keypress` never reaches it, so "Undo Last Skip"
 * cannot be driven from the IPC test harness at all.
 */

ObjC.import("Foundation");

function readFile(path) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(
    path,
    $.NSUTF8StringEncoding,
    null
  );
  if (!text) throw new Error("cannot read " + path);
  return ObjC.unwrap(text);
}

// --------------------------------------------------------------------------
// Стенд
// --------------------------------------------------------------------------

/*
 * opts:
 *   url          — адрес текущего файла
 *   duration     — длительность
 *   edl          — текст сайдкара, либо null если его нет
 *   chapters     — список глав [{time, title}], либо null
 *   prefs        — переопределения настроек
 *   network      — считать источник сетевым
 */
function makeWorld(opts) {
  const world = {
    seeks: [],      // куда плагин перематывал
    commands: [],   // все команды mpv
    osd: [],        // показанные сообщения
    reads: [],      // какие файлы читал
    handlers: {},   // подписки на события IINA
    panel: {        // всё, что плагин сделал с боковой панелью
      loaded: [],
      messages: [],
      handlers: {},
      calls: [],
    },
    status: {
      url: opts.url || "file:///v/ep.mkv",
      position: 0,
      duration: opts.duration || 180,
      isNetworkResource: !!opts.network,
      paused: false,
      idle: false,
    },
  };

  const prefs = opts.prefs || {};
  // Сайдкар «лежит» рядом с любым файлом, иначе смена серии в плейлисте
  // выглядела бы как переход к файлу без разметки.
  const hasEdl = function (p) {
    return opts.edl != null && p.slice(-4) === ".edl";
  };

  world.api = {
    core: {
      status: world.status,
      osd: function (m) { world.osd.push(m); },
    },
    event: {
      on: function (name, cb) { world.handlers[name] = cb; },
    },
    sidebar: {
      loadFile: function (p) {
        world.panel.loaded.push(p);
        world.panel.calls.push("loadFile");
        // Загрузка страницы сбрасывает ранее заданные обработчики — именно на
        // этом панель однажды и зависла на "Loading…".
        world.panel.handlers = {};
      },
      onMessage: function (name, cb) {
        world.panel.calls.push("onMessage:" + name);
        world.panel.handlers[name] = cb;
      },
      postMessage: function (name, data) {
        world.panel.messages.push([name, data]);
      },
      show: function () {},
      hide: function () {},
    },
    mpv: {
      command: function (name, args) {
        world.commands.push([name].concat(args));
        // Перемотка должна двигать позицию, иначе следующий тик увидит старую.
        if (name === "seek" && args[1] === "absolute+exact") {
          const target = parseFloat(args[0]);
          world.seeks.push(target);
          world.status.position = target;
        }
      },
      getNative: function (name) {
        if (name === "chapter-list") return opts.chapters || null;
        return null;
      },
    },
    menu: {
      item: function () { return {}; },
      addItem: function () {},
      removeAllItems: function () {},
      forceUpdate: function () {},
    },
    console: { log: function () {} },
    file: {
      exists: function (p) { return hasEdl(p); },
      read: function (p) {
        world.reads.push(p);
        if (hasEdl(p)) return opts.edl;
        throw new Error("no such file");
      },
    },
    preferences: {
      get: function (k) { return k in prefs ? prefs[k] : null; },
      set: function (k, v) { prefs[k] = v; },
      sync: function () {},
    },
  };

  return world;
}

function loadPlugin(repo, world) {
  const source = readFile(repo + "/index.js");
  const factory = new Function(
    "iina",
    source +
      "\nreturn { onPositionChanged: onPositionChanged," +
      " undoLastSkip: undoLastSkip, loadSegments: loadSegments," +
      " segmentsFromChapters: segmentsFromChapters };"
  );
  return factory(world.api);
}

// Проигрывает `seconds` секунд шагами по 0.5 с, как делает time-pos.
function play(plugin, world, seconds) {
  const step = 0.5;
  for (let t = 0; t < seconds; t += step) {
    world.status.position += step;
    plugin.onPositionChanged();
  }
}

// --------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(name + "\n    получено: " + a + "\n    ожидалось: " + e);
}

function near(name, actual, expected, tolerance) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failures.push(
      name + "\n    получено: " + actual + "\n    ожидалось: ≈" + expected
    );
  }
}

// Наш обычный сайдкар: recap 0–15, intro 30–60, титры 150–180 (до конца).
const EDL =
  "## Recap\n0.000\t15.000\t3\n" +
  "## Intro\n30.000\t60.000\t3\n" +
  "## Outro / Credits\n150.000\t180.000\t3\n";

const CHAPTERS = [
  { time: 0, title: "Recap" },
  { time: 30, title: "Intro" },
  { time: 60, title: "Episode" },
  { time: 150, title: "Credits" },
];

// --------------------------------------------------------------------------

function testSkipsOncePerPlayback(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  w.status.position = 28;
  play(p, w, 6); // въезжаем в интро
  check("интро пропущено", w.seeks, [60]);

  // Зритель отматывает назад в уже пропущенное интро.
  w.status.position = 40;
  play(p, w, 6);
  check("повторно не выбрасывает", w.seeks, [60]);
}

function testUndo(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  w.status.position = 29.5;
  play(p, w, 3);
  check("интро пропущено", w.seeks, [60]);

  p.undoLastSkip();
  near("вернулись примерно туда, откуда прыгнули", w.seeks[1], 30, 1.0);

  // И остались: сегмент помечен использованным.
  play(p, w, 6);
  check("после отмены не выбрасывает", w.seeks.length, 2);
}

function testUndoWithNothingToUndo(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  p.undoLastSkip();
  check("перемотки не было", w.seeks, []);
  check("сказано, что отменять нечего", w.osd, ["Nothing to undo"]);
}

function testChaptersFallback(repo) {
  const w = makeWorld({ edl: null, chapters: CHAPTERS });
  const p = loadPlugin(repo, w);

  // Глава Recap тянется до следующей главы, то есть до 30 — а там сразу
  // начинается Intro, поэтому прыжки идут подряд, без паузы на воспроизведение.
  play(p, w, 3);
  check("recap и intro по главам подряд", w.seeks, [30, 60]);
}

function testSidecarWinsOverChapters(repo) {
  const w = makeWorld({ edl: EDL, chapters: CHAPTERS });
  const p = loadPlugin(repo, w);

  play(p, w, 3);
  // Сайдкар даёт recap 0–15, главы дали бы 0–30.
  check("сайдкар важнее глав", w.seeks, [15]);
}

function testChaptersDisabled(repo) {
  const w = makeWorld({
    edl: null,
    chapters: CHAPTERS,
    prefs: { use_chapters: false },
  });
  const p = loadPlugin(repo, w);

  play(p, w, 5);
  check("главы выключены — не пропускаем", w.seeks, []);
}

function testEndOfFileModes(repo) {
  const playMode = makeWorld({ edl: EDL, prefs: { end_of_file: "play" } });
  const p1 = loadPlugin(repo, playMode);
  playMode.status.position = 148;
  play(p1, playMode, 6);
  check("режим play: титры не трогаем", playMode.seeks, []);

  const nextMode = makeWorld({ edl: EDL, prefs: { end_of_file: "next" } });
  const p2 = loadPlugin(repo, nextMode);
  nextMode.status.position = 148;
  play(p2, nextMode, 6);
  check("режим next: команда плейлиста", nextMode.commands, [
    ["playlist-next", "weak"],
  ]);
  p2.undoLastSkip();
  check(
    "переход к другому файлу отменять нечего",
    nextMode.osd[nextMode.osd.length - 1],
    "Nothing to undo"
  );

  const skipMode = makeWorld({ edl: EDL });
  const p3 = loadPlugin(repo, skipMode);
  skipMode.status.position = 148;
  play(p3, skipMode, 6);
  check("режим skip: прыжок в конец", skipMode.seeks, [180]);
}

function testPerKindSwitches(repo) {
  const w = makeWorld({ edl: EDL, prefs: { skip_intro: false } });
  const p = loadPlugin(repo, w);

  play(p, w, 3);
  check("recap всё ещё пропускается", w.seeks, [15]);

  w.status.position = 29;
  play(p, w, 4);
  check("интро оставлено включённым зрителю", w.seeks, [15]);
}

function testMasterSwitchOff(repo) {
  const w = makeWorld({ edl: EDL, prefs: { enabled: false } });
  const p = loadPlugin(repo, w);

  play(p, w, 5);
  check("выключено — ничего не пропускаем", w.seeks, []);
}

function testNetworkSourceUntouched(repo) {
  const w = makeWorld({
    url: "http://host/ep.mkv",
    edl: EDL,
    chapters: CHAPTERS,
    network: true,
  });
  const p = loadPlugin(repo, w);

  play(p, w, 5);
  check("сетевой источник не трогаем", w.seeks, []);
  check("в файловую систему не лезем", w.reads, []);
}

function testFileChangeResetsState(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  play(p, w, 3);
  check("recap первой серии пропущен", w.seeks, [15]);

  // Плейлист поехал дальше: адрес сменился, позиция снова у начала.
  w.status.url = "file:///v/ep2.mkv";
  w.status.position = 0;
  play(p, w, 3);
  check("вторая серия обработана заново", w.seeks, [15, 15]);
}

function testShortRemainderNotSkipped(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  // До конца интро осталось меньше порога — прыгать незачем.
  w.status.position = 59.7;
  play(p, w, 1);
  check("хвост сегмента не трогаем", w.seeks, []);
}

function testSidebar(repo) {
  const w = makeWorld({ edl: EDL });
  const p = loadPlugin(repo, w);

  // Окна ещё нет — трогать панель нельзя, иначе получим то же, что с
  // menu.forceUpdate() при загрузке: обращение к недостроенному плееру.
  play(p, w, 3);
  check("до window-loaded в панель не пишем", w.panel.messages, []);
  check("страница не загружается раньше времени", w.panel.loaded, []);

  w.handlers["iina.window-loaded"]();
  check("страница панели загружена", w.panel.loaded, ["sidebar.html"]);
  check("обработчики заданы после загрузки страницы", w.panel.calls, [
    "loadFile",
    "onMessage:ready",
    "onMessage:seek",
  ]);
  check("всё ещё молчим, страница не ответила", w.panel.messages, []);

  // Страница сообщает, что готова принимать.
  w.panel.handlers["ready"]();
  check("после ready пришёл список", w.panel.messages.length, 1);
  check("имя сообщения", w.panel.messages[0][0], "segments");

  const payload = w.panel.messages[0][1];
  check(
    "список сегментов",
    payload.segments.map(function (s) {
      return [s.label, s.start, s.end, s.used];
    }),
    [
      ["Recap", 0, 15, true], // recap уже пропущен за первые тики
      ["Intro", 30, 60, false],
      ["Credits", 150, 180, false],
    ]
  );

  // Пропуск обновляет панель.
  const before = w.panel.messages.length;
  w.status.position = 29;
  play(p, w, 3);
  check("панель обновилась после пропуска", w.panel.messages.length > before, true);

  const last = w.panel.messages[w.panel.messages.length - 1][1];
  check(
    "интро помечено пропущенным",
    last.segments[1].used,
    true
  );

  // Клик по строке в панели.
  const seeksBefore = w.seeks.length;
  w.panel.handlers["seek"]({ time: 30 });
  check("клик перематывает", w.seeks[seeksBefore], 30);
  w.panel.handlers["seek"](null);
  check("мусор из панели игнорируется", w.seeks.length, seeksBefore + 1);
}

// --------------------------------------------------------------------------

function run(argv) {
  const repo = argv[0];
  if (!repo) throw new Error("не передан путь к репозиторию");

  testSkipsOncePerPlayback(repo);
  testUndo(repo);
  testUndoWithNothingToUndo(repo);
  testChaptersFallback(repo);
  testSidecarWinsOverChapters(repo);
  testChaptersDisabled(repo);
  testEndOfFileModes(repo);
  testPerKindSwitches(repo);
  testMasterSwitchOff(repo);
  testNetworkSourceUntouched(repo);
  testFileChangeResetsState(repo);
  testShortRemainderNotSkipped(repo);
  testSidebar(repo);

  const total = passed + failures.length;
  if (failures.length) {
    let report = "\nПРОВАЛЕНО " + failures.length + " из " + total + ":\n\n";
    failures.forEach(function (f) {
      report += "  ✗ " + f + "\n\n";
    });
    throw new Error(report);
  }
  return "OK: " + passed + " проверок из " + total + " прошли\n";
}
