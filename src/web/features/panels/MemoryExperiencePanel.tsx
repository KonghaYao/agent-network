import { Button, Pagination } from '../../app/lenso-controls';
import { MemoryList } from './MemoryPanelList';
import { text, time } from './memory-format';
import type { MemoryPanelController } from './useMemoryPanelController';

type Props = Pick<
  MemoryPanelController,
  | 'experiences'
  | 'experienceStatus'
  | 'experienceMore'
  | 'experienceDetail'
  | 'loadExperiences'
  | 'openExperience'
>;

export function MemoryExperiencePanel({
  experiences,
  experienceStatus,
  experienceMore,
  experienceDetail,
  loadExperiences,
  openExperience,
}: Props) {
  return (
    <>
      <div className="memory-toolbar">
        <Button
          id="memory-experience-refresh"
          className="memory-small-btn"
          type="button"
          onClick={() => void loadExperiences(true)}
        >
          刷新
        </Button>
      </div>
      <p id="memory-experience-status" className="memory-state" role="status">
        {experienceStatus}
      </p>
      <MemoryList id="memory-experience-list">
        {experiences.map((item, index) => (
          <div className="memory-list-item" role="listitem" key={text(item.experience_id, String(index))}>
            <Button
              className="memory-row"
              style={{ minHeight: 44, justifyContent: 'flex-start' }}
              type="button"
              onClick={() => void openExperience(text(item.experience_id))}
            >
              <span className="memory-row-title">
                {text(item.summary, text(item.experience_id, '经历'))}
              </span>
              <span className="memory-row-meta">
                {text(item.origin_kind, '来源未知')} · {time(item.created_at)}
              </span>
            </Button>
          </div>
        ))}
      </MemoryList>
      {experienceMore ? (
        <Pagination style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 8 }} aria-label="经历分页">
          <Button
            id="memory-experience-more"
            className="memory-page-btn"
            type="button"
            onClick={() => void loadExperiences(false)}
          >
            加载更多
          </Button>
        </Pagination>
      ) : null}
      {experienceDetail ? (
        <div id="memory-experience-detail" className="memory-detail">
          <h3>经历详情</h3>
          {experienceDetail.available === false ? (
            <p className="memory-note">当前不可读：{experienceDetail.reason || '原因未知'}</p>
          ) : (
            <pre className="memory-body-text">{experienceDetail.text}</pre>
          )}
        </div>
      ) : null}
    </>
  );
}
