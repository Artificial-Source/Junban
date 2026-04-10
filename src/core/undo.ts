export interface UndoableAction {
  description: string;
  execute(): Promise<void>;
  undo(): Promise<void>;
}

const MAX_STACK_DEPTH = 50;

/**
 * Undo/redo manager using the command pattern.
 * Each mutation is wrapped as an UndoableAction.
 */
export class UndoManager {
  private undoStack: UndoableAction[] = [];
  private redoStack: UndoableAction[] = [];
  private subscribers = new Set<() => void>();
  private operationQueue: Promise<void> = Promise.resolve();

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Execute an action and push it to the undo stack. */
  async perform(action: UndoableAction): Promise<void> {
    await this.runExclusive(async () => {
      await action.execute();
      this.undoStack.push(action);
      if (this.undoStack.length > MAX_STACK_DEPTH) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      this.notify();
    });
  }

  /** Undo the most recent action. */
  async undo(): Promise<UndoableAction | null> {
    return this.runExclusive(async () => {
      const action = this.undoStack.pop();
      if (!action) return null;
      await action.undo();
      this.redoStack.push(action);
      this.notify();
      return action;
    });
  }

  /** Redo the most recently undone action. */
  async redo(): Promise<UndoableAction | null> {
    return this.runExclusive(async () => {
      const action = this.redoStack.pop();
      if (!action) return null;
      await action.execute();
      this.undoStack.push(action);
      this.notify();
      return action;
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.subscribers]) {
      listener();
    }
  }
}
