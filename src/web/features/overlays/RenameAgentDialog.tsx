import { useEffect, useState, type FormEvent } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

/**
 * Agent 全局改名。名称变化会影响所有房间中的显示，不改变联系人备注。
 */
export function RenameAgentDialog({
  open,
  onOpenChange,
  actorId,
  currentName,
  token,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorId: string;
  currentName: string;
  token: string;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setStatus('');
    setBusy(false);
  }, [currentName, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setStatus('名称不能为空');
      return;
    }
    if (value.length > LIMITS.actorNameMax) {
      setStatus(`名称最多 ${LIMITS.actorNameMax} 个字符`);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const result = await callTool<{ name: string }>(
        'network_agent_rename',
        { request_id: newRequestId('web_agent_rename'), actor_id: actorId, name: value },
        { token },
      );
      onRenamed(result.name || value);
      onOpenChange(false);
    } catch (failure) {
      setStatus(`改名失败：${(failure as McpError).message || String(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="改名"
      titleId="rename-modal-title"
      contentId="rename-modal"
      footer={
        <div className="row modal-actions">
          <button id="rename-cancel" type="button" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button id="rename-save" className="primary" type="submit" form="rename-form" disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </button>
        </div>
      }
    >
      <form id="rename-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Agent 新名称</span>
          <input
            id="rename-input"
            maxLength={LIMITS.actorNameMax}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p id="rename-status" className="form-error" role="status">
          {status}
        </p>
      </form>
    </Modal>
  );
}
