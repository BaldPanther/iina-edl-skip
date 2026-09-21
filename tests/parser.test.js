/*
 * Unit tests for the pure parsing helpers in index.js.
 *
 * Run them with the JavaScriptCore that ships with macOS — the same engine
 * family IINA runs plugins in, and no npm, node or build step anywhere:
 *
 *     ./tests/run.sh
 *
 * index.js is loaded as-is, wrapped in a function that receives a stub `iina`
 * object and hands the internals back. Nothing is copied or re-implemented
 * here, so the tests always run against the file that actually ships.
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

// Everything index.js touches at load time, doing nothing.
function stubIINA() {
  const noop = function () {};
  return {
    core: { status: {}, osd: noop },
    event: { on: noop },
    mpv: { command: noop, getNative: function () { return null; } },
    menu: {
      item: function () { return {}; },
      addItem: noop,
      removeAllItems: noop,
      forceUpdate: noop,
    },
    console: { log: noop },
    file: {
      exists: function () { return false; },
      read: function () { return ""; },
    },
    preferences: { get: function () { return null; }, set: noop, sync: noop },
  };
}

function loadPlugin(repo) {
  const source = readFile(repo + "/index.js");
  const factory = new Function(
    "iina",
    source +
      "\nreturn { parseEdl: parseEdl, parseTime: parseTime," +
      " edlPathFor: edlPathFor, urlToPath: urlToPath," +
      " kindFromMarker: kindFromMarker };"
  );
  return factory(stubIINA());
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

function segments(list) {
  return list.map(function (s) {
    return [s.start, s.end, s.kind];
  });
}

// --------------------------------------------------------------------------

function testParseTime(p) {
  check("секунды", p.parseTime("102.000"), 102);
  check("ноль", p.parseTime("0"), 0);
  check("часы:минуты:секунды", p.parseTime("00:01:42.000"), 102);
  check("минуты:секунды", p.parseTime("01:42.000"), 102);
  check("целый час", p.parseTime("1:00:00"), 3600);
  check("мусор", p.parseTime("abc"), null);
  check("пусто", p.parseTime(""), null);
  check("мусор в часах", p.parseTime("00:xx:10"), null);
}

function testEdlPathFor(p) {
  check(
    "обычное имя",
    p.edlPathFor("/v/Show - S01E02 - Name.mkv"),
    "/v/Show - S01E02 - Name.edl"
  );
  check(
    "точки в имени",
    p.edlPathFor("/v/Show.2024.1080p.BluRay.mkv"),
    "/v/Show.2024.1080p.BluRay.edl"
  );
  check("без расширения", p.edlPathFor("/v/noext"), "/v/noext.edl");
  check("скрытый файл", p.edlPathFor("/v/.hidden"), "/v/.hidden.edl");
  check("точка в каталоге", p.edlPathFor("/v.1/ep.mkv"), "/v.1/ep.edl");
}

function testUrlToPath(p) {
  check(
    "file:// с процентами",
    p.urlToPath("file:///Users/me/Show%20S01E01.mkv"),
    "/Users/me/Show S01E01.mkv"
  );
  check("абсолютный путь", p.urlToPath("/v/ep.mkv"), "/v/ep.mkv");
  check("сеть отбрасывается", p.urlToPath("http://host/ep.mkv"), "");
  check("smb отбрасывается", p.urlToPath("smb://host/ep.mkv"), "");
  check("пусто", p.urlToPath(""), "");
  check("кириллица", p.urlToPath("file:///v/%D0%A1%D0%B5%D1%80%D0%B8%D1%8F.mkv"),
        "/v/Серия.mkv");
}

function testParseEdl(p) {
  const ours =
    "## Recap (в предыдущих сериях)\n0.000\t42.000\t3\n" +
    "## Intro\n42.000\t102.000\t3\n" +
    "## Outro / Credits\n3300.000\t3533.000\t3\n";
  check("наш файл целиком", segments(p.parseEdl(ours)), [
    [0, 42, "recap"],
    [42, 102, "intro"],
    [3300, 3533, "credits"],
  ]);

  check(
    "только интро",
    segments(p.parseEdl("## Intro\n42.000\t102.000\t3\n")),
    [[42, 102, "intro"]]
  );

  check(
    "пробелы вместо табуляций",
    segments(p.parseEdl("## Intro\n42.000 102.000 3\n")),
    [[42, 102, "intro"]]
  );

  check(
    "переводы строк CRLF",
    segments(p.parseEdl("## Intro\r\n42.000\t102.000\t3\r\n")),
    [[42, 102, "intro"]]
  );

  check(
    "время часами",
    segments(p.parseEdl("## Intro\n00:00:42\t00:01:42\t3\n")),
    [[42, 102, "intro"]]
  );

  check(
    "действие 0 тоже пропуск",
    segments(p.parseEdl("## Intro\n10.000\t20.000\t0\n")),
    [[10, 20, "intro"]]
  );

  check(
    "действия 1 и 2 игнорируются",
    segments(p.parseEdl("10.000\t20.000\t1\n30.000\t40.000\t2\n")),
    []
  );

  check(
    "конец раньше начала отбрасывается",
    segments(p.parseEdl("## Intro\n50.000\t20.000\t3\n")),
    []
  );

  check(
    "нулевая длина отбрасывается",
    segments(p.parseEdl("## Intro\n50.000\t50.000\t3\n")),
    []
  );

  check("пустой файл", segments(p.parseEdl("")), []);
  check("только комментарии", segments(p.parseEdl("## Intro\n## Outro\n")), []);
  check(
    "битые строки пропускаются",
    segments(p.parseEdl("мусор\n10.000\n## Intro\n42.000\t102.000\t3\n")),
    [[42, 102, "intro"]]
  );

  // Маркер действует ровно на одну следующую строку с данными: вторая строка
  // остаётся без маркера и раскладывается по положению — как последняя, в
  // титры. Если бы маркер протекал, здесь стояло бы "intro".
  check(
    "маркер не протекает на вторую строку",
    segments(
      p.parseEdl("## Intro\n42.000\t102.000\t3\n200.000\t260.000\t3\n")
    ),
    [
      [42, 102, "intro"],
      [200, 260, "credits"],
    ]
  );

  // Чужой файл без маркеров: раскладка по положению.
  check(
    "без маркеров — по положению",
    segments(
      p.parseEdl("0.000\t42.000\t3\n100.000\t160.000\t3\n3300.000\t3533.000\t3\n")
    ),
    [
      [0, 42, "recap"],
      [100, 160, "intro"],
      [3300, 3533, "credits"],
    ]
  );

  check(
    "без маркеров, один сегмент в конце",
    segments(p.parseEdl("3300.000\t3533.000\t3\n")),
    [[3300, 3533, "credits"]]
  );

  check(
    "порядок строк не важен",
    segments(p.parseEdl("## Intro\n42.000\t102.000\t3\n## Recap\n0.000\t42.000\t3\n")),
    [
      [0, 42, "recap"],
      [42, 102, "intro"],
    ]
  );
}

function testKindFromMarker(p) {
  check("recap", p.kindFromMarker("## recap (в предыдущих сериях)"), "recap");
  check("intro", p.kindFromMarker("## intro"), "intro");
  check("outro", p.kindFromMarker("## outro / credits"), "credits");
  check("credits", p.kindFromMarker("## closing credits"), "credits");
  check("чужой маркер", p.kindFromMarker("## something else"), null);
}

// --------------------------------------------------------------------------

function run(argv) {
  const repo = argv[0];
  if (!repo) throw new Error("не передан путь к репозиторию");

  const plugin = loadPlugin(repo);

  testParseTime(plugin);
  testEdlPathFor(plugin);
  testUrlToPath(plugin);
  testParseEdl(plugin);
  testKindFromMarker(plugin);

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
