import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import { newAgentFormSchema, type NewAgentForm } from '../../../contracts/web-forms';
import { addLocalAgent, agentConnectPrompt } from '../../lib/agents';
import { copyText } from '../../lib/files';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { queryKeys } from '../../lib/query-keys';
import type { WebIdentity } from '../../lib/identity';
import { Modal } from './Modal';

interface CreatedAgent {
  actor_id: string;
  name: string;
  agent_session_id: string | null;
  token: string;
  mcp_url: string;
  share_url?: string;
}

interface CreatedRoom {
  room?: { room_id?: string; head_seq?: string };
}

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  identity: WebIdentity | null;
  token: string | null;
}

/**
 * 新建 Agent：RHF 只校验名称，服务端生成一次性 token 与 MCP URL。
 *
 * 关闭弹窗即清空 token / URL / 提示词；成功后在当前浏览器注册表写入
 * Agent 自己的 MCP URL，并建立 direct 会话。凭据只进入只读输入框与剪贴板。
 */
export function NewAgentDialog({ open, onOpenChange, identity, token }: NewAgentDialogProps) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [copied, setCopied] = useState<'url' | 'prompt' | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewAgentForm>({
    resolver: zodResolver(newAgentFormSchema),
    defaultValues: { name: '' },
  });

  useEffect(() => {
    if (open) return;
    setCreated(null);
    setPrompt('');
    setError('');
    setWarning('');
    setCopied(null);
    reset({ name: '' });
  }, [open, reset]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const close = (next: boolean) => {
    if (isSubmitting) return;
    onOpenChange(next);
  };

  const submit = handleSubmit(async (values) => {
    if (!identity || !token) {
      setError('浏览器身份尚未初始化，请刷新页面后重试');
      return;
    }
    setError('');
    setWarning('');
    try {
      const agent = await callTool<CreatedAgent>(
        'network_agent_create',
        {
          request_id: newRequestId('web_agent_create'),
          name: values.name,
        },
        { token },
      );
      if (!agent.token || !agent.mcp_url || !agent.actor_id) {
        throw new Error('服务端未返回有效的 MCP URL');
      }
      setCreated(agent);
      setPrompt(agentConnectPrompt(agent.token, agent.actor_id));
      const registryError = addLocalAgent(identity.actor_id, {
        owner_actor_id: identity.actor_id,
        actor_id: agent.actor_id,
        name: agent.name || values.name,
        agent_session_id: agent.agent_session_id,
        created_at: String(Date.now()),
        mcp_url: agent.mcp_url,
      });
      let roomError = '';
      try {
        const detail = await callTool<CreatedRoom>(
          'network_room_create',
          {
            request_id: newRequestId('web_agent_room'),
            kind: 'direct',
            members: [agent.actor_id],
          },
          { token },
        );
        const roomId = detail.room?.room_id;
        if (roomId && detail.room?.head_seq) {
          await callTool(
            'network_room_mark_read',
            { room_id: roomId, through_seq: detail.room.head_seq },
            { token },
          ).catch(() => undefined);
        }
        if (roomId) {
          await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) });
        }
      } catch (failure) {
        roomError = (failure as McpError).message || String(failure);
      }
      const warnings: string[] = [];
      if (roomError) warnings.push(`会话添加失败：${roomError}`);
      if (registryError) warnings.push(registryError);
      if (warnings.length > 0) setWarning(`Agent 已创建，但${warnings.join('；')}`);
      reset({ name: '' });
    } catch (failure) {
      setError(`创建失败：${(failure as McpError).message || String(failure)}`);
    }
  });

  const copy = async (kind: 'url' | 'prompt') => {
    const value = kind === 'url' ? created?.mcp_url : prompt;
    if (!value) {
      setError(kind === 'url' ? 'MCP URL 尚未生成' : '提示词尚未生成');
      return;
    }
    try {
      await copyText(value);
      setError('');
      setCopied(kind);
    } catch (failure) {
      setError(`复制失败：${(failure as Error).message || String(failure)}`);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="新建 Agent"
      titleId="new-agent-title"
      contentId="new-agent-modal"
      className="new-agent-card"
      footer={
        <div className="row modal-actions">
          <button id="new-agent-close" type="button" onClick={() => close(false)} disabled={isSubmitting}>
            关闭
          </button>
          <button
            className="primary"
            id="new-agent-create"
            type="submit"
            form="new-agent-form"
            disabled={isSubmitting || created !== null}
          >
            {isSubmitting ? '创建中…' : created ? '已创建' : '创建'}
          </button>
        </div>
      }
    >
      <form id="new-agent-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Agent 名称</span>
          <input
            id="new-agent-name"
            type="text"
            maxLength={LIMITS.actorNameMax}
            placeholder="例如：翻译助手"
            autoComplete="off"
            disabled={created !== null}
            {...register('name')}
          />
        </label>
        {errors.name ? <p className="field-error">{errors.name.message}</p> : null}
        {error ? (
          <p id="new-agent-error" className="form-error" role="status">
            {error}
          </p>
        ) : null}
        {created ? (
          <div id="new-agent-result" className="new-agent-result">
            <p className="new-agent-warning">
              MCP URL 与提示词含长期 token，只在本机使用；不要截图、发群或写入日志。
            </p>
            <label className="field">
              <span>MCP URL</span>
              <input id="new-agent-url" type="text" readOnly value={created.mcp_url} />
            </label>
            <button
              className="new-agent-copy"
              id="new-agent-copy"
              type="button"
              onClick={() => void copy('url')}
            >
              {copied === 'url' ? '已复制' : '复制 MCP URL'}
            </button>
            <div className="new-agent-prompt">
              <label className="field">
                <span>提示词</span>
                <textarea
                  id="new-agent-prompt"
                  className="new-agent-prompt-text"
                  rows={9}
                  readOnly
                  spellCheck={false}
                  wrap="soft"
                  value={prompt}
                />
              </label>
              <button
                className="new-agent-copy"
                id="new-agent-prompt-copy"
                type="button"
                onClick={() => void copy('prompt')}
              >
                {copied === 'prompt' ? '已复制' : '复制提示词'}
              </button>
            </div>
          </div>
        ) : null}
        {warning ? (
          <p id="new-agent-warning" className="form-error" role="status">
            {warning}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
