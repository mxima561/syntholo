"use client";

export function CopyId({ value, label }: { value: string; label?: string }) {
  return (
    <button
      className="copy-id"
      onClick={() => navigator.clipboard.writeText(value)}
      title="Copy ID"
      type="button"
    >
      <code>{label ?? value}</code>
    </button>
  );
}
