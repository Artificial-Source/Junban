import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

const program = new Command();
const services = bootstrap();

program.name("saydo").description("ASF Saydo — Task management from the terminal").version("0.1.0");

program
  .command("add <description>")
  .description("Add a new task (supports natural language)")
  .option("--json", "Output as JSON")
  .action(async (description: string, options) => {
    const { addTask } = await import("./commands/add.js");
    await addTask(description, services, options);
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
    const { listTasks } = await import("./commands/list.js");
    await listTasks(options, services);
  });

program
  .command("done <id>")
  .description("Mark a task as completed")
  .option("--json", "Output as JSON")
  .action(async (id: string, options) => {
    const { doneTask } = await import("./commands/done.js");
    await doneTask(id, services, options);
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
    const { editTask } = await import("./commands/edit.js");
    await editTask(id, options, services);
  });

program
  .command("delete <id>")
  .description("Delete a task")
  .option("--json", "Output as JSON")
  .action(async (id: string, options) => {
    const { deleteTask } = await import("./commands/delete.js");
    await deleteTask(id, services, options);
  });

program.parse();
