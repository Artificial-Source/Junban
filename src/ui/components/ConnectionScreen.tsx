/** Accessible connection screen shown when no bearer token is present. */

export function ConnectionScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-surface text-on-surface">
      <div className="max-w-md text-center px-6">
        <img
          src="/images/logo.svg"
          alt="Junban logo"
          className="h-12 w-12 mx-auto mb-4 rounded-lg ring-1 ring-border/60 bg-white object-contain p-2"
        />
        <h1 className="text-xl font-bold text-on-surface mb-2">Junban</h1>
        <p className="text-sm text-on-surface-secondary mb-4">
          No access token found. Ask your Junban host for a connection URL that includes an access
          token in the URL fragment.
        </p>
        <p className="text-xs text-on-surface-muted">
          The URL should look like:
          <br />
          <code className="font-mono text-on-surface-secondary break-all">
            https://your-host/#access_token=...
          </code>
        </p>
      </div>
    </div>
  );
}
