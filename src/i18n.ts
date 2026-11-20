/**
 * Interface language support for the MAX channel plugin.
 *
 * Russian is the default; users can switch the whole bot interface to English
 * via `channels.max.language` or a per-account `accounts.<id>.language`
 * override. Both channel.ts and webhook-handler.ts resolve the language
 * through the same account object (ResolvedMaxAccount.language), so one
 * account always speaks one language.
 *
 * The ru dictionary is byte-identical to the pre-i18n user-facing strings —
 * local agent conventions depend on markers like `[📎 Файл: … — путь: …]`.
 */

export type Lang = "ru" | "en";

export const DEFAULT_LANG: Lang = "ru";

/**
 * Single language resolution point:
 * account.language ?? channel-level language ?? "ru".
 * Any invalid value resolves to the default ("ru").
 */
export function resolveLang(accountLanguage?: unknown, channelLanguage?: unknown): Lang {
  const raw = accountLanguage ?? channelLanguage ?? DEFAULT_LANG;
  return raw === "ru" || raw === "en" ? raw : DEFAULT_LANG;
}

/** All user-facing strings. Placeholders use {name} and are filled by t(). */
const ru = {
  // Live progress draft
  working: "⏳ Работаю…",

  // Inbound attachment marker (agent conventions depend on the ru format)
  fileForwarded: "переслано, ",
  fileMarker: "[📎 Файл: {filename} ({forwarded}{type}, {size}, {mime}) — путь: {path}]",

  // Keyboard buttons
  prevPage: "◀ Пред",
  nextPage: "След ▶",
  backToProviders: "« Назад к провайдерам",
  chooseModel: "Выбрать модель",

  // Pairing approval DM
  accessGranted: "✅ OpenClaw: доступ разрешён.",

  // Media send fallback when upload/attachment failed
  attachmentFallback: "[вложение: {name}]",

  // Bot command menu descriptions
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

  // Forward / reply prefixes
  unknownSender: "неизвестный",
  replyWhoFallback: "сообщение",
  forwardPrefix: "[↪ Переслано от {who}{idPart}]",
  attachmentQuote: "(вложение: {types})",
  replyPrefixQuoted: "[↩ Ответ на {who}: {quote}]",
  replyPrefix: "[↩ Ответ на {who}]",

  // Interactive settings menu titles
  menuReasoningTitle: "Настройка показа хода мыслей (reasoning):",
  menuFastTitle: "Режим Fast Mode:",
  menuVerboseTitle: "Подробный режим вывода (verbose):",
  menuUsageTitle: "Отображение расхода токенов (usage footer):",
  menuTtsTitle: "Управление озвучкой (TTS):",
  menuElevatedTitle: "Режим повышенных привилегий (elevated):",
  menuToolsTitle: "Режим отображения списка инструментов:",

  // Interactive settings menu buttons
  btnOn: "Вкл (on)",
  btnOff: "Выкл (off)",
  btnStream: "Потоково (stream)",
  btnAuto: "Авто (auto)",
  btnDefault: "По умолчанию",
  btnStatus: "Статус",
  btnCompact: "Компактный (compact)",
  btnVerbose: "Подробный (verbose)",

  // Owner-only command warning
  ownerOnlyWarning:
    "⚠️ Команда доступна только владельцу бота (Owner). Для изменения прав обратитесь к администратору.",

  // Dynamic /think menu title
  thinkMenuTitle:
    "Текущий уровень размышлений: {level}.\nМодель: {model} ({provider})\nВыберите уровень размышлений:",
};

export type StringKey = keyof typeof ru;

/** English mirror — the compiler enforces the exact same key set as ru. */
const en: Record<StringKey, string> = {
  working: "⏳ Working…",

  fileForwarded: "forwarded, ",
  fileMarker: "[📎 File: {filename} ({forwarded}{type}, {size}, {mime}) — path: {path}]",

  prevPage: "◀ Prev",
  nextPage: "Next ▶",
  backToProviders: "« Back to providers",
  chooseModel: "Choose model",

  accessGranted: "✅ OpenClaw: access granted.",

  attachmentFallback: "[attachment: {name}]",

  cmdModels: "Browse and switch models",
  cmdModel: "Current model or switch (/model provider/model)",
  cmdNew: "Start a new session",
  cmdStatus: "Bot, agent and context status",
  cmdHelp: "Help for all commands",
  cmdCommands: "Full command list",
  cmdTools: "List available tools",
  cmdCompact: "Compact the conversation context",
  cmdThink: "Thinking depth (off/low/medium/high)",
  cmdReset: "Reset the current session",
  cmdStop: "Stop the current generation",
  cmdRestart: "Restart OpenClaw",
  cmdUsage: "Token usage and statistics",
  cmdTts: "Voice output (TTS) controls",
  cmdVoice: "Choose the voice for TTS",
  cmdFast: "Fast mode (on/off)",
  cmdReasoning: "Show reasoning (on/off)",
  cmdVerbose: "Verbose output mode",
  cmdWhoami: "Show my messenger ID",
  cmdContext: "Current context information",
  cmdTasks: "Background task list",
  cmdSubagents: "Running subagents",
  cmdSkills: "List available skills",
  cmdWeather: "Weather and forecast",
  cmdHumanizer: "Humanize text",
  cmdNotion: "Notion integration",
  cmdGog: "Google Workspace (Drive, mail, calendars)",

  unknownSender: "unknown",
  replyWhoFallback: "message",
  forwardPrefix: "[↪ Forwarded from {who}{idPart}]",
  attachmentQuote: "(attachment: {types})",
  replyPrefixQuoted: "[↩ Reply to {who}: {quote}]",
  replyPrefix: "[↩ Reply to {who}]",

  menuReasoningTitle: "Reasoning display settings (reasoning):",
  menuFastTitle: "Fast Mode:",
  menuVerboseTitle: "Verbose output mode (verbose):",
  menuUsageTitle: "Token usage display (usage footer):",
  menuTtsTitle: "Voice output controls (TTS):",
  menuElevatedTitle: "Elevated privileges mode (elevated):",
  menuToolsTitle: "Tool list display mode:",

  btnOn: "On",
  btnOff: "Off",
  btnStream: "Stream",
  btnAuto: "Auto",
  btnDefault: "Default",
  btnStatus: "Status",
  btnCompact: "Compact",
  btnVerbose: "Verbose",

  ownerOnlyWarning:
    "⚠️ This command is only available to the bot owner. Contact the administrator to change permissions.",

  thinkMenuTitle:
    "Current thinking level: {level}.\nModel: {model} ({provider})\nChoose a thinking level:",
};

export const STRINGS: Record<Lang, Record<StringKey, string>> = { ru, en };

/**
 * Look up a user-facing string and fill {placeholder} variables.
 * Unknown keys fall back to the key itself (never throws).
 */
export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const dict = STRINGS[lang] ?? STRINGS[DEFAULT_LANG];
  let s = dict[key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      s = s.split(`{${name}}`).join(String(value));
    }
  }
  return s;
}
