import { Button, Input, Label } from '../../app/lenso-controls';
import { MemoryChip } from './memory-row';
import { shortHash, time } from './memory-format';
import type { MemoryPanelController } from './useMemoryPanelController';

type Props = Pick<
  MemoryPanelController,
  'manifestId' | 'setManifestId' | 'manifest' | 'manifestStatus' | 'submitManifest'
>;

export function MemoryHostPanel({
  manifestId,
  setManifestId,
  manifest,
  manifestStatus,
  submitManifest,
}: Props) {
  return (
    <>
      <div id="memory-host-info" className="memory-host-info">
        <p className="memory-note">
          宿主绑定由已鉴权宿主会话创建；本面板只展示服务端等级与清单状态，
          不会代替宿主声明可信、已注入或已提交。
        </p>
      </div>
      <form id="memory-manifest-form" className="memory-form" onSubmit={(event) => void submitManifest(event)}>
        <div className="memory-field">
          <Label htmlFor="memory-manifest-id">manifest_id</Label>
          <Input
            id="memory-manifest-id"
            type="text"
            maxLength={128}
            autoComplete="off"
            placeholder="宿主提交清单后返回的 manifest_id"
            value={manifestId}
            onChange={(event) => setManifestId(event.target.value)}
          />
        </div>
        <Button className="primary memory-submit" type="submit">
          查询清单状态
        </Button>
      </form>
      <p id="memory-manifest-status" className="memory-state" role="status">
        {manifestStatus}
      </p>
      <div id="memory-manifest-result" className="memory-result">
        {manifest ? (
          <div className="memory-detail">
            <div className="memory-detail-head">
              <h3>提交清单状态</h3>
              <MemoryChip>{manifest.status}</MemoryChip>
            </div>
            <dl>
              <dt>提交证据</dt>
              <dd>{manifest.submitted_evidence ?? '无'}</dd>
              <dt>可提炼资格</dt>
              <dd>{manifest.retain_eligible ? '是' : '否'}</dd>
              <dt>清单 hash</dt>
              <dd>{shortHash(manifest.manifest_sha256)}</dd>
              <dt>payload hash</dt>
              <dd>{shortHash(manifest.payload_sha256)}</dd>
              <dt>创建时间</dt>
              <dd>{time(manifest.created_at)}</dd>
            </dl>
            <p className="memory-note">
              prepared 与宿主排队不是提交证据；retain_eligible 只由服务端采纳合格回执后更新。
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
