import { usePluginContext } from "../context/PluginContext.js";

export function StatusBar() {
  const { statusBarItems } = usePluginContext();

  if (statusBarItems.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-1 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-400">
      {statusBarItems.map((item) => (
        <span key={item.id} className="flex items-center gap-1">
          <span>{item.icon}</span>
          <span>{item.text}</span>
        </span>
      ))}
    </div>
  );
}
