import { ContactRequestsDialog } from '../overlays/ContactRequestsDialog';
import { GroupCreateDialog } from '../overlays/GroupCreateDialog';

export interface AppSidebarDialogsProps {
  groupOpen: boolean;
  contactsOpen: boolean;
  onGroupOpenChange: (open: boolean) => void;
  onContactsOpenChange: (open: boolean) => void;
}

/**
 * 侧栏弹窗集合。
 *
 * 由 `AppSidebarDialogsMount` 懒加载并在首次加载后保持挂载；关闭弹窗只改变
 * `open`，因此 Radix 的关闭后焦点返回与 legacy 行为一致。
 */
export function AppSidebarDialogs({
  groupOpen,
  contactsOpen,
  onGroupOpenChange,
  onContactsOpenChange,
}: AppSidebarDialogsProps) {
  return (
    <>
      <GroupCreateDialog open={groupOpen} onOpenChange={onGroupOpenChange} />
      <ContactRequestsDialog open={contactsOpen} onOpenChange={onContactsOpenChange} />
    </>
  );
}
