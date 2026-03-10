import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { useGeneralSettings } from "../../context/SettingsContext.js";

interface DeleteActionProps {
  taskId: string;
  onDelete: (id: string) => void;
}

export function DeleteAction({ taskId, onDelete }: DeleteActionProps) {
  const { settings } = useGeneralSettings();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => {
          if (settings.confirm_delete === "true") {
            setConfirmDeleteOpen(true);
            return;
          }
          onDelete(taskId);
        }}
        className="text-sm text-error hover:text-error/80 flex items-center gap-1.5 transition-colors w-full"
      >
        <Trash2 size={14} />
        Delete task
      </button>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete task"
        message="This task will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          onDelete(taskId);
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </>
  );
}
