import { Link } from '../../app/lenso-controls';
import { fileDownloadUrl, type RoomFileItem } from '../../lib/files-ui';

export function FileDownloadLink({ item, id, children }: {
  item: RoomFileItem;
  id?: string;
  children: string;
}) {
  const href = fileDownloadUrl(item);
  return href ? (
    <Link id={id} href={href} download={item.name || '文件'} rel="noopener" referrerPolicy="no-referrer">
      {children}
    </Link>
  ) : null;
}
