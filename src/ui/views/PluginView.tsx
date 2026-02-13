import { useState, useEffect, useRef } from "react";
import { api } from "../api.js";

interface PluginViewProps {
  viewId: string;
}

export function PluginView({ viewId }: PluginViewProps) {
  const [content, setContent] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchContent = async () => {
      try {
        const text = await api.getPluginViewContent(viewId);
        if (mountedRef.current) setContent(text);
      } catch {
        // Non-critical
      }
    };

    fetchContent();
    const interval = setInterval(fetchContent, 1000);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [viewId]);

  return (
    <div>
      <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 font-mono">
        {content}
      </pre>
    </div>
  );
}
