#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import type { AppServices } from "../bootstrap.js";
import { APP_VERSION } from "../config/defaults.js";
import { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import { setDefaultLogLevel } from "../utils/logger.js";

setDefaultLogLevel("warn");

const program = new Command();
let services: AppServices | null = null;

async function getServices(): Promise<AppServices> {
  if (!services) {
    const { bootstrap } = await import("../bootstrap.js");
    services = bootstrap();
  }
  return services;
}

function formatCliError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof ValidationError) return `Validation error: ${err.message}`;
  if (err instanceof StorageError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function wantsJsonOutput(): boolean {
  return process.argv.includes("--json");
}

interface RunCommandOptions {
  jsonErrors?: boolean;
}

async function runCommand(
  action: (services: AppServices) => Promise<void>,
  options: RunCommandOptions = {},
): Promise<void> {
  try {
    await action(await getServices());
  } catch (err) {
    const message = formatCliError(err);
    console.error(
      options.jsonErrors ? JSON.stringify({ success: false, error: message }) : message,
    );
    process.exitCode = 1;
  }
}

program
  .name("junban")
  .description("Junban — Task management from the terminal")
  .version(APP_VERSION)
  .exitOverride()
  .showHelpAfterError()
  .showSuggestionAfterError();

program.configureOutput({
  writeErr: (str) => {
    if (!wantsJsonOutput()) process.stderr.write(str);
  },
});

program
  .command("add <description>")
  .description("Add a new task (supports natural language)")
  .option("--json", "Output as JSON")
  .action(async (description: string, options) => {
    await runCommand(
      async (services) => {
        const { addTask } = await import("./commands/add.js");
        await addTask(description, services, options);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("list")
  .description("List tasks")
  .option("--today", "Show only today's tasks")
  .option("--project <name>", "Filter by project")
  .option("--tag <name>", "Filter by tag")
  .option("--search <query>", "Search tasks")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await runCommand(
      async (services) => {
        const { listTasks } = await import("./commands/list.js");
        await listTasks(options, services);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("done <id>")
  .description("Mark a task as completed")
  .option("--json", "Output as JSON")
  .action(async (id: string, options) => {
    await runCommand(
      async (services) => {
        const { doneTask } = await import("./commands/done.js");
        await doneTask(id, services, options);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("edit <id>")
  .description("Edit a task")
  .option("--title <title>", "New title")
  .option("--priority <p>", "New priority (1-4)")
  .option("--due <date>", "New due date")
  .option("--description <desc>", "New description")
  .option("--json", "Output as JSON")
  .action(async (id: string, options) => {
    await runCommand(
      async (services) => {
        const { editTask } = await import("./commands/edit.js");
        await editTask(id, options, services);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("delete <id>")
  .description("Delete a task")
  .option("--json", "Output as JSON")
  .action(async (id: string, options) => {
    await runCommand(
      async (services) => {
        const { deleteTask } = await import("./commands/delete.js");
        await deleteTask(id, services, options);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("tools")
  .description("List AI/agent tools available through Junban")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await runCommand(
      async (services) => {
        const { listTools } = await import("./commands/tools.js");
        await listTools(services, options);
      },
      { jsonErrors: options.json },
    );
  });

program
  .command("tool <name>")
  .description("Run a registered AI/agent tool with JSON arguments")
  .option("--args <json>", "JSON object arguments for the tool")
  .option("--args-file <path>", "Read JSON arguments from a file, or '-' for stdin")
  .option("--json", "Wrap the tool response in a stable JSON envelope")
  .action(async (name: string, options) => {
    await runCommand(
      async (services) => {
        const { runTool } = await import("./commands/tools.js");
        await runTool(name, services, options);
      },
      { jsonErrors: options.json },
    );
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CommanderError) {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exitCode = err.exitCode;
      return;
    }

    if (wantsJsonOutput()) {
      console.error(JSON.stringify({ success: false, error: err.message }));
    }
    process.exitCode = err.exitCode || 1;
    return;
  }

  console.error(formatCliError(err));
  process.exitCode = 1;
});
