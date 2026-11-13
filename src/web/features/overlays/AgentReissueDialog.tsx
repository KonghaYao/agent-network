import { useState } from 'react';

import { copyText } from '../../lib/files';
import { Modal } from './Modal';

/**
 * Agent 新 token 提示词：重置只发生一次，复制是单独动作。
 *
 * token 只存在于父组件内存；关闭后卸载。复制优先使用 Clipboard API，
 * 失败时由 `copyText` 回退到 textarea + execCommand。
 */
export function AgentReissueDialog({
  open,
  onOpenChange,
  agentName,
  prompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  prompt: string;
}) {
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(prompt);
      setCopied(true);
      setStatus('已复制新提示词；凭据只给目标 Agent，勿发群、日志或截图。');
    } catch (error) {
      setStatus(
        `复制失败：${error instanceof Error ? error.message : String(error)}。请手动全选下面的提示词。`,
      );
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setStatus('');
          setCopied(false);
        }
        onOpenChange(next);
      }}
      title="重置链接"
      titleId="agent-reissue-title"
      contentId="agent-reissue-modal"
      className="agent-reissue-card"
      footer={
        <div className="row modal-actions">
          <button id="agent-reissue-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      }
    >
      <p className="contact-link-hint">
        {agentName} 的新 token 已生成，旧 token 已失效。只复制下面的提示词，不会再次更换 token。
      </p>
      <label className="field">
        <span>新提示词</span>
        <textarea
          id="room-menu-reissue-text"
          className="room-menu-reissue-text"
          rows={8}
          readOnly
          value={prompt}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <div className="row">
        <button id="room-menu-reissue-copy-prompt" className="primary" type="button" onClick={() => void copy()}>
          {copied ? '已复制' : '复制提示词'}
        </button>
      </div>
      <p id="room-menu-reissue-status" className="contact-link-status" role="status">
        {status}
      </p>
    </Modal>
  );
}
