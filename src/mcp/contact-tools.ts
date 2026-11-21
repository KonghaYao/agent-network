import { z } from 'zod';
import {
  contactAddSchema,
  contactBlockSchema,
  contactBlocksListSchema,
  contactPolicyGetSchema,
  contactPolicySetSchema,
  contactRemoveSchema,
  contactReportSchema,
  contactReportsListSchema,
  contactRequestIdSchema,
  contactRequestRespondSchema,
  contactRequestSchema,
  contactRequestsListSchema,
  contactSearchSchema,
  contactLinkCreateSchema,
  contactLinkListSchema,
  contactLinkPreviewSchema,
  contactLinkRedeemSchema,
  contactLinkRevokeSchema,
  contactUnblockSchema,
  contactsListSchema,
} from '../contracts/schemas';
import { contactAdd, contactRemove, contactsList } from '../domain/contacts';
import { contactSearch } from '../domain/contact-search';
import {
  contactBlock,
  contactBlocksList,
  contactReport,
  contactReportsList,
  contactUnblock,
} from '../domain/contact-blocks';
import { contactPolicyGet, contactPolicySet } from '../domain/contact-policies';
import {
  contactLinkCreate,
  contactLinkList,
  contactLinkPreview,
  contactLinkRedeem,
  contactLinkRevoke,
} from '../domain/contact-invite-links';
import {
  contactRequest,
  contactRequestCancel,
  contactRequestRespond,
  contactRequestsList,
} from '../domain/contact-requests';
import { requireActor } from './auth';
import {
  contactBlockPageSchema,
  contactBlockResultSchema,
  contactPageSchema,
  contactLinkCreateResultSchema,
  contactLinkListResultSchema,
  contactLinkPreviewResultSchema,
  contactLinkRedeemResultSchema,
  contactLinkRevokeResultSchema,
  contactPolicySchema,
  contactReportPageSchema,
  contactReportResultSchema,
  contactRequestPageSchema,
  contactRequestResultSchema,
  contactSearchResultSchema,
  contactSchema,
  contactUnblockResultSchema,
  removedResultSchema,
} from './outputs';
import type { Principal } from '../domain/principal';
import type { RegistrationServer } from './registration';
import { register } from './tool-registration';

export function registerContactTools(
  server: RegistrationServer,
  db: D1Database,
  principal: Principal,
  origin: string,
): void {
  register(
    server,
    'network_contacts_list',
    '按创建时间倒序分页读取自己的联系人与收藏。relation=active 才是双向好友；none 只是个人历史收藏，不代表对方同意，也不能用于建群或单聊授权。',
    contactsListSchema,
    contactPageSchema,
    async (input) => {
      requireActor(principal);
      return contactsList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_search',
    '按展示名称搜索可申请的身份。搜索词会折叠全角/半角、ASCII 大小写与多余空白。返回未停用、未与当前身份发生双向拉黑的目标，并排除自己。human 全局可搜；agent 仅当调用者已管理/受托管理、与其共享活跃房间、已有好友关系或待处理申请时出现，归档 Agent 不出现。不返回 metadata、凭据、房间或消息。结果包含完整 actor_id，供同名用户核对后再调用 network_contact_request { actor_id }。搜索本身不创建收藏、好友关系、申请、事件或未读；relation=active 表示已是好友，pending_request 表示已有待处理申请。',
    contactSearchSchema,
    contactSearchResultSchema,
    async (input) => {
      requireActor(principal);
      return contactSearch(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_add',
    '幂等写入自己的个人收藏/历史。该操作不建立好友关系、不通知对方，也不能用于建群、创建单聊或发送 direct 消息；加好友请用 network_contact_request。',
    contactAddSchema,
    z.object({ contact: contactSchema }),
    async (input) => {
      requireActor(principal);
      return contactAdd(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_remove',
    '删除自己的个人收藏，并结束双方好友关系；不删除历史消息或群成员身份。',
    contactRemoveSchema,
    removedResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRemove(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request',
    '向 actor_id 或 agent_session_id 发起好友申请。申请只进入独立的申请收件箱，不创建 direct 房间、不发送房间消息，陌生人无法借此写入单聊。管理者向自有 Agent 申请时自动建立关系；其他目标按接收策略处理（human 默认本人确认、有管理者的 Agent 默认管理者确认、无管理者 Agent 默认自行确认），不会因为 kind=agent 自动接受。已存在 pending 时返回该申请；已是好友时 already_friends=true。建群或加成员不要求先发好友申请：未认领或自有管理者的 Agent 可直接加入。通知只落持久事件，不产生 delivery，也不唤醒 Agent 执行任务。',
    contactRequestSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequest(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_requests_list',
    '分页读取好友申请。direction=incoming 同时包含自己管理的 Agent 的申请；status 可过滤状态。读取时会把已过期的 pending 就地标记为 expired，但不会因此产生 delivery 或唤醒 Agent。',
    contactRequestsListSchema,
    contactRequestPageSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestsList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request_respond',
    '接受或拒绝 pending 好友申请。只有申请目标、其管理者或受托人可以处理，发起者不能自批。接受后双方建立 active 关系，并在同一事务内自动确保存在 direct 单聊房间（确定性 room_id，已有房间不重建、重复接受不重复建房），返回同一申请；重复接受返回同一结果，已过期返回 REQUEST_EXPIRED。拒绝不删除历史消息。',
    contactRequestRespondSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestRespond(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request_cancel',
    '撤销自己发起且仍 pending 的好友申请；已结束返回冲突，已过期返回 REQUEST_EXPIRED。',
    contactRequestIdSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_link_create',
    '生成一次性好友邀请链接，返回 { link, share_url }。链接 24 小时内有效、只能使用一次、只能由创建者撤销；share_url 形如 `${PUBLIC_ORIGIN}/#friend=<token>`，token 明文只在首次响应出现一次，服务端只保存 SHA-256 摘要，同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE。每个身份最多同时保留 LIMITS.contactLinkPendingMax 条 pending 链接，超出返回 QUOTA_EXCEEDED。对方打开链接并登录后直接建立双向好友关系，不需要好友申请或审批。',
    contactLinkCreateSchema,
    contactLinkCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkCreate(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_contact_link_preview',
    '预览好友邀请链接是否可用，无需已注册身份。只返回 valid、status、邀请人展示信息与 expires_at；无效、过期、已使用或已撤销返回 valid=false 与 reason，不创建身份、不消耗链接、不返回 token 摘要。网页在自动注册前先调用该工具，确保错误链接不会产生替代身份。',
    contactLinkPreviewSchema,
    contactLinkPreviewResultSchema,
    async (input) => contactLinkPreview(db, input),
  );

  register(
    server,
    'network_contact_link_redeem',
    '兑换好友邀请链接：直接建立双方 active `contact_relations`（source=invite_link）与个人收藏，并在同一事务内自动确保存在 direct 单聊房间（确定性 room_id，已有房间不重建），不创建 pending 好友申请、不要求审批。自己兑换返回 INVALID_ARGUMENT；任一方向拉黑返回 BLOCKED；已存在 active 关系时 already_friends=true 且不消费链接；链接过期/已用/已撤销/无效返回 CONTACT_LINK_INVALID（details.reason 区分 expired/used/revoked/invalid）。成功后 links 置为 used，事件只写持久 inbox/outbox 提示与新建房间的 room_created，不产生 delivery、不增加 pending_count。同一 request_id 重放返回首次结果。',
    contactLinkRedeemSchema,
    contactLinkRedeemResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkRedeem(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_link_list',
    '读取自己生成的好友邀请链接状态，按创建时间倒序；只返回 link_id、status、expires_at、used_by 展示信息与 can_revoke，从不返回 token、token_hash 或 share_url。pending 且已过期的链接在读取时标记为 expired；used_by 只展示兑换者，不代表可读其消息或房间。',
    contactLinkListSchema,
    contactLinkListResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_link_revoke',
    '撤销自己生成且未使用的好友邀请链接。只有 owner 可撤销，其他身份返回 PERMISSION_DENIED；已使用链接返回 CONFLICT；重复撤销幂等返回 already_revoked=true。撤销后立即无法兑换，但已建立的 contact_relations 不受影响。',
    contactLinkRevokeSchema,
    contactLinkRevokeResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkRevoke(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_policy_get',
    '读取好友接收策略；省略 actor_id 表示自己。人类可读自己，Agent 可由其管理者或持有 manage_agent 委托的 human 读取。configured=false 表示当前是按身份与管理者关系解析出的默认值。',
    contactPolicyGetSchema,
    contactPolicySchema,
    async (input) => {
      requireActor(principal);
      return contactPolicyGet(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_policy_set',
    '设置好友接收策略，仅人类管理者可调用。self_approval=本人确认；manager_approval=管理者确认（仅 Agent）；auto_accept=自动接受，必须显式设置，不是 kind=agent 的默认行为。人类不能使用 manager_approval。修改只影响后续申请，不改变已有关系。',
    contactPolicySetSchema,
    contactPolicySchema,
    async (input) => {
      requireActor(principal);
      return contactPolicySet(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_block',
    '拉黑一个 actor：结束当前好友关系、取消同 pair 的 pending 申请，并拒绝后续私聊、好友申请与 direct 邀请。不会移除共同群成员、不会删除历史消息或单侧收藏。mute_mentions 默认 true，按个人设置静默共同群里来自被拉黑者的定向 @ 通知；普通群消息仍按群权限可见。拉黑不产生 delivery，也不唤醒 Agent。',
    contactBlockSchema,
    contactBlockResultSchema,
    async (input) => {
      requireActor(principal);
      return contactBlock(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_unblock',
    '解除自己发起的拉黑。只释放拉黑状态，不会自动恢复好友关系；需要重新建立关系时必须重新发起好友申请。共同群成员身份与历史消息不受影响。',
    contactUnblockSchema,
    contactUnblockResultSchema,
    async (input) => {
      requireActor(principal);
      return contactUnblock(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_blocks_list',
    '分页读取自己发起的拉黑记录（含已解除）。只返回 blocker 自己的记录，不暴露谁拉黑了自己。',
    contactBlocksListSchema,
    contactBlockPageSchema,
    async (input) => {
      requireActor(principal);
      return contactBlocksList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_report',
    '举报一个 actor，可选附带房间与消息定位。服务端只保存类别、短备注、房间/消息 ID 与消息序号等最小必要证据，不复制消息正文，不通知被举报者，也不对外发送。返回 status=received 作为接收回执；举报只进入受控管理流程。',
    contactReportSchema,
    contactReportResultSchema,
    async (input) => {
      requireActor(principal);
      return contactReport(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_reports_list',
    '分页读取自己提交的举报及接收状态。举报不会产生 delivery，也不会唤醒 Agent。',
    contactReportsListSchema,
    contactReportPageSchema,
    async (input) => {
      requireActor(principal);
      return contactReportsList(db, principal, input);
    },
  );
}
