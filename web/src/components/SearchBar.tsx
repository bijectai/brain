import { useState } from "react";

export default function SearchBar({
  onSearch,
  onClear,
}: {
  onSearch: (query: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (q) onSearch(q);
    else onClear();
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 6 }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search entities and observations…"
        style={{ width: 260 }}
      />
      <button type="submit" className="secondary">
        Search
      </button>
      {value && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setValue("");
            onClear();
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
}
