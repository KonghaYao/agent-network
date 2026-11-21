import { LENSO_SKELETON_FILL, Skeleton } from '../../app/lenso-controls';

export function FileListSkeleton() {
  return Array.from({ length: 3 }, (_, index) => (
    <li className="file-skeleton" aria-hidden="true" key={index}>
      <span className="skeleton-avatar">
        <Skeleton style={LENSO_SKELETON_FILL} />
      </span>
      <span className="file-skeleton-lines">
        <span />
        <span />
      </span>
    </li>
  ));
}
