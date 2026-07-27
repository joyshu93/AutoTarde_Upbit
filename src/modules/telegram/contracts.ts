import type {
  ParsedTelegramCommand,
  SupportedTelegramCommand,
  TelegramCommandContract,
} from "./interfaces.js";
import type { SupportedAsset } from "../../domain/types.js";

const TELEGRAM_COMMAND_CONTRACTS: readonly TelegramCommandContract[] = [
  {
    command: "/help",
    category: "inspection",
    usage: "/help",
    summary: "Show supported Telegram operator commands and safety boundaries.",
    argumentPolicy: "none",
  },
  {
    command: "/config",
    category: "inspection",
    usage: "/config",
    summary: "Show non-secret runtime configuration, safety gates, and explicit risk limits.",
    argumentPolicy: "none",
  },
  {
    command: "/readiness",
    category: "inspection",
    usage: "/readiness [detail]",
    summary: "Show a concise operator readiness summary or the complete technical readiness detail.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/status",
    category: "inspection",
    usage: "/status [detail]",
    summary: "Show a concise execution summary or the persisted technical execution detail.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/statehistory",
    category: "inspection",
    usage: "/statehistory",
    summary: "Show recent persisted execution_state transition history.",
    argumentPolicy: "none",
  },
  {
    command: "/synchistory",
    category: "inspection",
    usage: "/synchistory",
    summary: "Show recent persisted reconciliation_runs for operator inspection.",
    argumentPolicy: "none",
  },
  {
    command: "/recovery",
    category: "inspection",
    usage: "/recovery",
    summary: "Show checkpointed exchange-history recovery progress for operator inspection.",
    argumentPolicy: "none",
  },
  {
    command: "/alerts",
    category: "inspection",
    usage: "/alerts [detail]",
    summary: "Show a concise persisted alert and delivery-health summary or the canonical technical list.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/risks",
    category: "inspection",
    usage: "/risks [detail]",
    summary: "Show a concise persisted risk-history summary or the canonical technical list.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/balances",
    category: "inspection",
    usage: "/balances [detail]",
    summary: "Show a concise balance summary or the complete stored balance snapshot detail.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/positions",
    category: "inspection",
    usage: "/positions [detail]",
    summary: "Show a concise position summary or the complete stored position snapshot detail.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/orders",
    category: "inspection",
    usage: "/orders [detail]",
    summary: "Show a concise recent-order summary or the canonical stored order list.",
    argumentPolicy: "optional_detail",
  },
  {
    command: "/order",
    category: "inspection",
    usage: "/order <order-id|identifier> [detail]",
    summary: "Show a concise persisted order lifecycle summary or the canonical technical detail.",
    argumentPolicy: "order_reference_optional_detail",
  },
  {
    command: "/scheduler",
    category: "inspection",
    usage: "/scheduler",
    summary: "Show runtime scheduler status and recent persisted strategy_scheduler_runs for operator inspection.",
    argumentPolicy: "none",
  },
  {
    command: "/inbound",
    category: "inspection",
    usage: "/inbound",
    summary: "Show Telegram inbound polling status and persisted update offset.",
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
  {
    command: "/preview",
    category: "control",
    usage: "/preview BTC|ETH",
    summary: "Preview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.",
    argumentPolicy: "asset_required",
  },
  {
    command: "/run",
    category: "control",
    usage: "/run BTC|ETH",
    summary: "Run one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
    argumentPolicy: "asset_required",
  },
] as const;

const TELEGRAM_COMMAND_CONTRACT_MAP = new Map<SupportedTelegramCommand, TelegramCommandContract>(
  TELEGRAM_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]),
);

const MANUAL_INPUT_COMMANDS = new Set(["/setcash", "/setposition"]);

export function listSupportedTelegramCommands(): SupportedTelegramCommand[] {
  return TELEGRAM_COMMAND_CONTRACTS.map((contract) => contract.command);
}

export function listTelegramCommandContracts(): readonly TelegramCommandContract[] {
  return TELEGRAM_COMMAND_CONTRACTS;
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

  if (parsed.contract.argumentPolicy === "optional_detail") {
    return parsed.args.length === 0
      || (parsed.args.length === 1 && parsed.args[0]?.toLowerCase() === "detail")
      ? null
      : buildUsageMessage(parsed.command);
  }

  if (parsed.contract.argumentPolicy === "asset_required") {
    return parseTelegramAssetArg(parsed.args) === null ? buildUsageMessage(parsed.command) : null;
  }

  if (parsed.contract.argumentPolicy === "order_reference_optional_detail") {
    const validSummary =
      parsed.args.length === 1
      && Boolean(parsed.args[0]?.trim());
    const validDetail =
        parsed.args.length === 2
        && Boolean(parsed.args[0]?.trim())
        && parsed.args[1]?.toLowerCase() === "detail";
    return validSummary || validDetail
      ? null
      : buildUsageMessage(parsed.command);
  }

  if (parsed.args.length > 0) {
    return buildUsageMessage(parsed.command);
  }

  return null;
}

export function parseTelegramAssetArg(args: readonly string[]): SupportedAsset | null {
  if (args.length !== 1) {
    return null;
  }

  const normalizedAsset = args[0]?.toUpperCase();
  return normalizedAsset === "BTC" || normalizedAsset === "ETH" ? normalizedAsset : null;
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

  if (normalized === "/start") {
    return "/help";
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
