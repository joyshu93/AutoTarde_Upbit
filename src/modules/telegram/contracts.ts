import type {
  ParsedTelegramCommand,
  SupportedTelegramCommand,
  TelegramCommandContract,
} from "./interfaces.js";

const TELEGRAM_COMMAND_CONTRACTS: readonly TelegramCommandContract[] = [
  {
    command: "/status",
    category: "inspection",
    usage: "/status",
    summary: "Show execution mode, live gate, and operator control state.",
    argumentPolicy: "none",
  },
  {
    command: "/balances",
    category: "inspection",
    usage: "/balances",
    summary: "Show the latest stored exchange balance snapshot.",
    argumentPolicy: "none",
  },
  {
    command: "/positions",
    category: "inspection",
    usage: "/positions",
    summary: "Show the latest stored exchange position snapshot.",
    argumentPolicy: "none",
  },
  {
    command: "/orders",
    category: "inspection",
    usage: "/orders",
    summary: "Show stored order lifecycle records.",
    argumentPolicy: "none",
  },
  {
    command: "/pause",
    category: "control",
    usage: "/pause [reason]",
    summary: "Pause execution without enabling any manual trading path.",
    argumentPolicy: "optional_reason",
  },
  {
    command: "/resume",
    category: "control",
    usage: "/resume",
    summary: "Resume execution when the kill switch is clear.",
    argumentPolicy: "none",
  },
  {
    command: "/killswitch",
    category: "control",
    usage: "/killswitch [reason]",
    summary: "Activate the global kill switch and halt execution.",
    argumentPolicy: "optional_reason",
  },
  {
    command: "/sync",
    category: "control",
    usage: "/sync",
    summary: "Request a reconciliation sync through the operator control plane.",
    argumentPolicy: "none",
  },
] as const;

const TELEGRAM_COMMAND_CONTRACT_MAP = new Map<SupportedTelegramCommand, TelegramCommandContract>(
  TELEGRAM_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]),
);

const MANUAL_INPUT_COMMANDS = new Set(["/setcash", "/setposition"]);

export function listSupportedTelegramCommands(): SupportedTelegramCommand[] {
  return TELEGRAM_COMMAND_CONTRACTS.map((contract) => contract.command);
}

export function parseTelegramCommand(input: string): ParsedTelegramCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand = "", ...args] = trimmed.split(/\s+/u);
  const normalizedCommand = normalizeCommandToken(rawCommand);
  if (!normalizedCommand) {
    return null;
  }

  const contract = TELEGRAM_COMMAND_CONTRACT_MAP.get(normalizedCommand);
  if (!contract) {
    return null;
  }

  return {
    command: normalizedCommand,
    args,
    contract,
  };
}

export function validateTelegramCommand(parsed: ParsedTelegramCommand): string | null {
  if (parsed.contract.argumentPolicy === "optional_reason") {
    return null;
  }

  if (parsed.args.length > 0) {
    return buildUsageMessage(parsed.command);
  }

  return null;
}

export function buildUnsupportedCommandMessage(input: string): string {
  const normalizedCommand = extractNormalizedCommand(input);
  const reason = normalizedCommand && MANUAL_INPUT_COMMANDS.has(normalizedCommand)
    ? "Manual cash and position input is not supported in Telegram."
    : "Unsupported command.";

  return `${reason} Supported commands: ${listSupportedTelegramCommands().join(" ")}`;
}

export function buildUsageMessage(command: SupportedTelegramCommand): string {
  const contract = TELEGRAM_COMMAND_CONTRACT_MAP.get(command);
  if (!contract) {
    return buildUnsupportedCommandMessage(command);
  }

  return `Usage: ${contract.usage}\n${contract.summary}`;
}

function extractNormalizedCommand(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand = ""] = trimmed.split(/\s+/u);
  return normalizeUnknownCommandToken(rawCommand);
}

function normalizeCommandToken(rawCommand: string): SupportedTelegramCommand | null {
  const normalized = normalizeUnknownCommandToken(rawCommand);
  if (!normalized) {
    return null;
  }

  if (!TELEGRAM_COMMAND_CONTRACT_MAP.has(normalized as SupportedTelegramCommand)) {
    return null;
  }

  return normalized as SupportedTelegramCommand;
}

function normalizeUnknownCommandToken(rawCommand: string): string | null {
  if (!rawCommand.startsWith("/")) {
    return null;
  }

  const [commandOnly = ""] = rawCommand.toLowerCase().split("@", 1);
  return commandOnly || null;
}
