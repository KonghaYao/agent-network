import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { Button } from '../../app/lenso-controls';
import type { ConfirmOptions } from './confirm';

export function ConfirmRenderer({ options, settle }: {
  options: ConfirmOptions;
  settle: (value: boolean) => void;
}) {
  return (
    <AlertDialogPrimitive.Root open onOpenChange={(open) => { if (!open) settle(false); }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="spa-dialog-overlay" />
        <AlertDialogPrimitive.Content id="confirm-dialog"
          className="modal-card spa-dialog-content confirm-card"
          aria-describedby="confirm-dialog-message">
          <AlertDialogPrimitive.Title asChild>
            <h2 id="confirm-dialog-title">{options.title}</h2>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <p className="confirm-message" id="confirm-dialog-message">{options.message}</p>
          </AlertDialogPrimitive.Description>
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel id="confirm-dialog-cancel" className="spa-dialog-button"
              onClick={() => settle(false)}>{options.cancelText ?? '取消'}</AlertDialogPrimitive.Cancel>
            {/* 先结算 true，不能让自动 Close 抢先结算 false。 */}
            <Button id="confirm-dialog-ok" type="button"
              className={`spa-dialog-button primary${options.danger ? ' danger' : ''}`}
              onClick={() => settle(true)}>{options.confirmText ?? '确定'}</Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
