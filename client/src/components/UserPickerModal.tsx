import { ModalOverlay, Modal, Dialog, Heading, Button } from "react-aria-components";
import { stampAriaModal } from "../lib/aria-modal";
import type { UserConfig } from "@roubo/shared";

export default function UserPickerModal({
  isOpen,
  onClose,
  onSelect,
  users,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (userName: string) => void;
  users: UserConfig[];
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-sm mx-4">
        <Dialog
          ref={stampAriaModal}
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-stone-200 dark:border-stone-800/60">
            <Heading
              slot="title"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
            >
              Select a user
            </Heading>
          </div>

          <div className="px-1 py-1">
            {users.map((user) => {
              const secondaryDetail = Object.values(user.properties)[0];
              return (
                <Button
                  key={user.name}
                  onPress={() => onSelect(user.name)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800/60 transition-colors outline-none"
                >
                  <span className="text-sm font-medium text-stone-800 dark:text-stone-200">
                    {user.name}
                  </span>
                  {secondaryDetail && (
                    <span className="text-xs font-mono text-stone-400 dark:text-stone-600 truncate">
                      {secondaryDetail}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
