import { STRINGS, resolveLang, t, DEFAULT_LANG } from "../dist/src/i18n.js";
import { resolveAccount } from "../dist/src/accounts.js";

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fail++; };

// 1. Key sets identical
const ruKeys = Object.keys(STRINGS.ru).sort();
const enKeys = Object.keys(STRINGS.en).sort();
ok(`key sets identical (${ruKeys.length} keys)`, JSON.stringify(ruKeys) === JSON.stringify(enKeys));
ok("no empty values", [...ruKeys].every(k => STRINGS.ru[k] && STRINGS.en[k]));

// 2. Resolution
ok("default ru", resolveLang(undefined, undefined) === "ru" && DEFAULT_LANG === "ru");
ok("en via channel config", resolveLang(undefined, "en") === "en");
ok("account override en", resolveLang("en", "ru") === "en");
ok("account override ru beats channel en", resolveLang("ru", "en") === "ru");
ok("invalid -> ru", resolveLang("fr", undefined) === "ru");
ok("invalid account value -> ru", resolveLang("xx", "en") === "ru");
ok("null account falls to channel", resolveLang(null, "en") === "en");
ok("non-string -> ru", resolveLang(42, {}) === "ru");

// 3. resolveAccount wiring (single resolution point)
const cfgEn = { channels: { max: { token: "t", language: "en" } } };
ok("resolveAccount default en", resolveAccount(cfgEn).language === "en");
ok("resolveAccount no language -> ru", resolveAccount({ channels: { max: { token: "t" } } }).language === "ru");
const cfgMulti = { channels: { max: { token: "t", language: "en", accounts: { work: { token: "w", language: "ru" }, bad: { token: "b", language: "de" } } } } };
ok("per-account override ru", resolveAccount(cfgMulti, "work").language === "ru");
ok("other account inherits en", resolveAccount(cfgMulti, "other").language === "en");
ok("invalid per-account -> ru", resolveAccount(cfgMulti, "bad").language === "ru");

// 4. ru strings byte-identical to pre-i18n originals
const originals = {
  working: "⏳ Работаю…",
  fileForwarded: "переслано, ",
  prevPage: "◀ Пред",
  nextPage: "След ▶",
  backToProviders: "« Назад к провайдерам",
  chooseModel: "Выбрать модель",
  accessGranted: "✅ OpenClaw: доступ разрешён.",
  cmdModels: "Выбор и переключение моделей",
  cmdModel: "Текущая модель или смена (/model provider/model)",
  cmdNew: "Начать новую сессию",
  cmdStatus: "Статус бота, агента и контекста",
  cmdHelp: "Справка по всем командам",
  cmdCommands: "Полный список команд",
  cmdTools: "Список доступных инструментов",
  cmdCompact: "Сжать контекст диалога",
  cmdThink: "Глубина размышлений (off/low/medium/high)",
  cmdReset: "Сбросить текущую сессию",
  cmdStop: "Остановить текущую генерацию",
  cmdRestart: "Перезапустить OpenClaw",
  cmdUsage: "Расход токенов и статистика",
  cmdTts: "Управление озвучкой (TTS)",
  cmdVoice: "Выбор голоса для озвучки",
  cmdFast: "Режим Fast mode (вкл/выкл)",
  cmdReasoning: "Показ хода мыслей (вкл/выкл)",
  cmdVerbose: "Подробный режим вывода",
  cmdWhoami: "Показать мой ID в мессенджере",
  cmdContext: "Информация о текущем контексте",
  cmdTasks: "Список фоновых задач",
  cmdSubagents: "Запущенные субагенты",
  cmdSkills: "Список доступных навыков",
  cmdWeather: "Погода и прогноз",
  cmdHumanizer: "Очеловечивание текстов",
  cmdNotion: "Интеграция с Notion",
  cmdGog: "Google Workspace (диск, почта, календари)",
  unknownSender: "неизвестный",
  replyWhoFallback: "сообщение",
  menuReasoningTitle: "Настройка показа хода мыслей (reasoning):",
  menuFastTitle: "Режим Fast Mode:",
  menuVerboseTitle: "Подробный режим вывода (verbose):",
  menuUsageTitle: "Отображение расхода токенов (usage footer):",
  menuTtsTitle: "Управление озвучкой (TTS):",
  menuElevatedTitle: "Режим повышенных привилегий (elevated):",
  menuToolsTitle: "Режим отображения списка инструментов:",
  btnOn: "Вкл (on)",
  btnOff: "Выкл (off)",
  btnStream: "Потоково (stream)",
  btnAuto: "Авто (auto)",
  btnDefault: "По умолчанию",
  btnStatus: "Статус",
  btnCompact: "Компактный (compact)",
  btnVerbose: "Подробный (verbose)",
  ownerOnlyWarning: "⚠️ Команда доступна только владельцу бота (Owner). Для изменения прав обратитесь к администратору.",
};
for (const [k, v] of Object.entries(originals)) ok(`ru byte-identical: ${k}`, STRINGS.ru[k] === v);

// 5. Rendered templates byte-identical to original interpolation
const f = { filename: "doc.pdf", attachmentType: "file", size: 2048, mimeType: "application/pdf", path: "/tmp/inbox/doc.pdf", isForwarded: true };
const formatBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
const fwd = f.isForwarded ? "переслано, " : "";
const expectedMarker = `[📎 Файл: ${f.filename} (${fwd}${f.attachmentType || "?"}, ${formatBytes(f.size)}, ${f.mimeType}) — путь: ${f.path}]`;
const gotMarker = t("ru", "fileMarker", { filename: f.filename, forwarded: fwd, type: f.attachmentType || "?", size: formatBytes(f.size), mime: f.mimeType, path: f.path });
ok("ru fileMarker byte-identical (forwarded)", gotMarker === expectedMarker);
const expectedMarker2 = `[📎 Файл: a.png (image, 1.0 KB, image/png) — путь: /x/a.png]`;
ok("ru fileMarker byte-identical (plain)", t("ru", "fileMarker", { filename: "a.png", forwarded: "", type: "image", size: "1.0 KB", mime: "image/png", path: "/x/a.png" }) === expectedMarker2);
ok("ru attachmentFallback", t("ru", "attachmentFallback", { name: "x.pdf" }) === "[вложение: x.pdf]");
ok("ru forwardPrefix", t("ru", "forwardPrefix", { who: "Ivan", idPart: " (id 123)" }) === "[↪ Переслано от Ivan (id 123)]");
ok("ru replyPrefixQuoted", t("ru", "replyPrefixQuoted", { who: "Ivan", quote: "hi" }) === "[↩ Ответ на Ivan: hi]");
ok("ru replyPrefix", t("ru", "replyPrefix", { who: "Ivan" }) === "[↩ Ответ на Ivan]");
ok("ru attachmentQuote", t("ru", "attachmentQuote", { types: "image, file" }) === "(вложение: image, file)");

// 6. en markers per spec
ok("en fileMarker", t("en", "fileMarker", { filename: "doc.pdf", forwarded: "forwarded, ", type: "file", size: "2.0 KB", mime: "application/pdf", path: "/tmp/doc.pdf" }) === "[📎 File: doc.pdf (forwarded, file, 2.0 KB, application/pdf) — path: /tmp/doc.pdf]");
ok("en forwardPrefix", t("en", "forwardPrefix", { who: "Ivan", idPart: "" }) === "[↪ Forwarded from Ivan]");
ok("en replyPrefixQuoted", t("en", "replyPrefixQuoted", { who: "Ivan", quote: "hi" }) === "[↩ Reply to Ivan: hi]");
ok("en attachmentFallback", t("en", "attachmentFallback", { name: "x.pdf" }) === "[attachment: x.pdf]");
ok("en working", t("en", "working") === "⏳ Working…");
ok("ru think title fully Russian", !/[A-Za-z]/.test(t("ru", "thinkMenuTitle", { level: "high", model: "m", provider: "p" }).replace(/high|m|p/g, "")));
ok("en think title fully English", !/[Ѐ-ӿ]/.test(t("en", "thinkMenuTitle", { level: "high", model: "m", provider: "p" })));

console.log(fail === 0 ? "\nALL I18N CHECKS PASSED" : `\n${fail} CHECKS FAILED`);
process.exit(fail === 0 ? 0 : 1);
