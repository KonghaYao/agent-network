import { cloneElement, createElement, type ComponentProps, type ComponentType, type ReactElement, type RefObject } from 'react';
import type { NumberFieldProps } from '@lenso/ui';
import type { LensoModule } from './lenso-display';
import type { MenuAdapterProps, NumberInputProps, RadioGroupAdapterProps, SegmentedControlAdapterProps, SelectAdapterProps } from './lenso-controls';

type Parts = ComponentType<Record<string, unknown>>;

export function SelectRenderer({ lenso, props, open, setOpen, triggerRef }: {
  lenso: LensoModule;
  props: SelectAdapterProps;
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: (node: HTMLButtonElement | null) => void;
}) {
  const { id, name, required, disabled, value, options, onChange, placeholder, className } = props;
  const Select = lenso.Select;
  return createElement(Select as unknown as Parts, {
    value: value === '' && placeholder && !options.some((option) => option.value === '') ? null : value,
    name, required, disabled, placeholder, open, onOpenChange: setOpen,
    items: options.map((option) => ({ ...option })),
    onValueChange: (next: string | null) => onChange(next ?? ''),
  },
  createElement(Select.Trigger as unknown as Parts, {
    id, ref: triggerRef, className,
    'aria-label': props['aria-label'],
    'aria-invalid': props['aria-invalid'],
    'aria-describedby': props['aria-describedby'],
    'data-lenso-slot': 'select-trigger',
  }, createElement(Select.Value), createElement(Select.Indicator)),
  createElement(Select.Content as unknown as Parts, null,
    options.map((option) => createElement(Select.Item as unknown as Parts, {
      key: option.value, value: option.value, disabled: option.disabled,
    }, createElement(Select.ItemText as unknown as Parts, null, option.label),
    createElement(Select.ItemIndicator as unknown as Parts))),
  ));
}

export function NumberRenderer({ lenso, props }: { lenso: LensoModule; props: NumberInputProps }) {
  const { id, value, min, max, step, disabled, onValueChange } = props;
  return createElement(lenso.NumberField, {
    value, min, max, step, disabled,
    onValueChange: (next: number | null) => onValueChange(next ?? 0),
  } as NumberFieldProps,
  createElement(lenso.NumberField.Group, null,
    createElement(lenso.NumberField.Input, {
      id, disabled, 'aria-label': props['aria-label'],
    } as ComponentProps<typeof lenso.NumberField.Input>),
    createElement(lenso.NumberField.IncrementButton),
    createElement(lenso.NumberField.DecrementButton),
  ));
}

export function SegmentedRenderer({ lenso, props }: { lenso: LensoModule; props: SegmentedControlAdapterProps }) {
  return createElement(lenso.SegmentedControl, props);
}

export function RadioRenderer({ lenso, props }: { lenso: LensoModule; props: RadioGroupAdapterProps }) {
  const { id, value, name, disabled, required, className, options, onChange, itemClassName } = props;
  return createElement(lenso.RadioGroup as unknown as Parts, {
    id, value: value === '' ? null : value, name, disabled, required, className,
    'aria-label': props['aria-label'], 'aria-labelledby': props['aria-labelledby'],
    'data-lenso-slot': 'radio-group',
    onValueChange: (next: string | null) => onChange(next ?? ''),
  }, options.map((option) => createElement(lenso.Radio as unknown as Parts, {
    key: option.value, value: option.value, disabled: option.disabled,
    className: itemClassName, 'data-lenso-slot': 'radio',
  }, createElement(lenso.Radio.Content as unknown as Parts, null,
    createElement(lenso.Radio.Control as unknown as Parts, null,
      createElement(lenso.Radio.Indicator as unknown as Parts)), option.label,
  ))));
}

export function MenuRenderer({ lenso, props, triggerRef, menuRef, instantHidden, hideBeforeSelect }: {
  lenso: LensoModule;
  props: MenuAdapterProps;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  instantHidden: boolean;
  hideBeforeSelect: () => void;
}) {
  const { id, trigger, items, label, className, itemClassName, open, onOpenChange, container, sideOffset, align } = props;
  return createElement(lenso.Menu as unknown as Parts, {
    open, onOpenChange,
    container: container ?? (typeof document === 'undefined' ? undefined : document.body),
  }, createElement(lenso.Menu.Trigger as unknown as Parts, {
    render: cloneElement(trigger as ReactElement<Record<string, unknown>>, {
      'aria-haspopup': 'menu', 'aria-controls': id, 'aria-expanded': open, ref: triggerRef,
    }),
  }), createElement(lenso.Menu.Content as unknown as Parts, {
    id, className, 'aria-label': label, sideOffset, align, ref: menuRef,
    style: { zIndex: 'var(--app-z-portal-local-menu)', ...(instantHidden ? { display: 'none' } : null) },
    render: createElement('div', { className }),
  }, items.map((item) => 'separator' in item
    ? createElement(lenso.Menu.Separator as unknown as Parts, { key: item.id, id: item.id })
    : createElement(lenso.Menu.Item as unknown as Parts, {
        key: item.id, id: item.id, variant: item.variant, disabled: item.disabled,
        onSelect: () => { hideBeforeSelect(); item.onSelect(); },
        render: createElement('div', { className: item.className ?? itemClassName }),
      }, item.label),
  )));
}
