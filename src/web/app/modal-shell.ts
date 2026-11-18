export type ModalShell = 'lenso' | 'radix';

const shells: { shell: ModalShell }[] = [];

/** 每次打开持有独立条目，允许非顶层先卸载与重复清理。 */
export function registerModalShell(shell: ModalShell): () => void {
  const entry = { shell };
  shells.push(entry);
  return () => {
    const index = shells.indexOf(entry);
    if (index !== -1) shells.splice(index, 1);
  };
}

export function getTopModalShell(): ModalShell | null {
  return shells.at(-1)?.shell ?? null;
}
