import { useState } from "react";

export default function ListSwitcher({ lists, currentListId, onSwitch, onCreate, onRename, onDelete, onReorder }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    await onCreate(newName.trim());
    setNewName("");
    setCreating(false);
  }

  async function handleRenameSubmit(e, listId) {
    e.preventDefault();
    if (!editName.trim()) return;
    await onRename(listId, editName.trim());
    setEditingId(null);
  }

  return (
    <div className="list-switcher">
      {lists.map((list, i) => (
        <div key={list.id} className={`list-tab ${list.id === currentListId ? "active" : ""}`}>
          {editingId === list.id ? (
            <form onSubmit={(e) => handleRenameSubmit(e, list.id)}>
              <input
                className="list-rename-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => setEditingId(null)}
                autoFocus
              />
            </form>
          ) : (
            <>
              <button type="button" className="list-tab-name" onClick={() => onSwitch(list.id)}>
                {list.name}
              </button>
              <span className="list-tab-actions">
                <button
                  type="button"
                  className="list-tab-icon-btn"
                  title="Rename"
                  onClick={() => {
                    setEditingId(list.id);
                    setEditName(list.name);
                  }}
                >
                  ✎
                </button>
                {i > 0 && (
                  <button type="button" className="list-tab-icon-btn" title="Move left" onClick={() => onReorder(list.id, "up")}>
                    ←
                  </button>
                )}
                {i < lists.length - 1 && (
                  <button type="button" className="list-tab-icon-btn" title="Move right" onClick={() => onReorder(list.id, "down")}>
                    →
                  </button>
                )}
                {lists.length > 1 && (
                  <button type="button" className="list-tab-icon-btn" title="Delete list" onClick={() => onDelete(list.id)}>
                    ✕
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      ))}

      {creating ? (
        <form onSubmit={handleCreate} className="list-create-form">
          <input
            className="list-rename-input"
            placeholder="List name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => !newName.trim() && setCreating(false)}
            autoFocus
          />
        </form>
      ) : (
        <button type="button" className="list-tab-add" onClick={() => setCreating(true)}>
          + New list
        </button>
      )}
    </div>
  );
}
