/**
 * Templates — Settings owner for template CRUD (moved from Filters & Labels).
 */
import { TemplatesSection } from "../../components/TemplatesSection";
import { useWorkspace } from "../../context/WorkspaceContext";
import { SettingsStatusBanner } from "./settingsComponents";

export function TemplatesTab() {
  const { catalog, catalogLoading, catalogError, refreshCatalog } = useWorkspace();

  if (catalogLoading && !catalog) {
    return <p className="text-sm text-on-surface-muted">Loading templates…</p>;
  }
  if (!catalog) {
    return (
      <SettingsStatusBanner kind="error">
        {catalogError ?? "Catalog is unavailable."}{" "}
        <button type="button" className="underline" onClick={() => refreshCatalog()}>
          Retry
        </button>
      </SettingsStatusBanner>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-on-surface">Templates</h2>
        <p className="mt-1 text-sm text-on-surface-muted">
          Create repeatable task templates and apply them from Quick Add.
        </p>
      </div>
      <TemplatesSection templates={catalog.templates} tags={catalog.tags} />
    </div>
  );
}
