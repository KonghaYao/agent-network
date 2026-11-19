import { createElement, useRef, type ComponentPropsWithRef } from 'react';
import { LensoBackendProvider, useFallbackLeaseLock, useLenso, useLensoBackendScope } from './lenso-runtime';

/** 只适配展示列表；选择、拖动和业务数据仍由调用方负责。 */
export function List(props: Omit<ComponentPropsWithRef<'ul'>, 'defaultValue'>) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  const locked = useFallbackLeaseLock();
  const node = useRef<HTMLUListElement | null>(null);
  const pinned = useRef(false);
  if ((!lenso && locked) || node.current?.contains(document.activeElement)) pinned.current = true;
  const ready = lenso && scope !== 'fallback' && !pinned.current;
  const { ref, ...rest } = props;
  return createElement(LensoBackendProvider, { backend: ready ? 'lenso' : 'fallback' },
    ready
      ? <lenso.List {...props} variant="plain" data-ui-list="" data-lenso-slot="list" />
      : createElement('ul', { ...rest, 'data-ui-list': '', 'data-lenso-slot': 'list-fallback',
          ref: (element: HTMLUListElement | null) => {
            node.current = element;
            if (typeof ref === 'function') return ref(element);
            if (ref) ref.current = element;
          } }));
}

export function ListItem(props: ComponentPropsWithRef<'li'>) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  return lenso && scope === 'lenso'
    ? <lenso.List.Item {...props} data-ui-list-item="" data-lenso-slot="list-item" />
    : createElement('li', { ...props, 'data-ui-list-item': '', 'data-lenso-slot': 'list-item-fallback' });
}
