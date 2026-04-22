import { describe, expect, it } from 'vitest';
import {
  GIT_LOG_FIELD_SEPARATOR,
  GIT_LOG_RECORD_SEPARATOR,
  parseGitLogOutput,
} from '../gitLogFormat';

describe('parseGitLogOutput', () => {
  it('parses subject and full message separately for multi-line commits', () => {
    const output =
      [
        'abc123',
        '2026-03-24 10:38:45 +0800',
        'Test Author',
        'test@example.com',
        'feat(workflow/approval): 增加可配置审批附件非修正附件预下载策略',
        [
          'feat(workflow/approval): 增加可配置审批附件非修正附件预下载策略',
          '',
          '- 增加预下载开关',
          '- 修复历史回显不完整',
        ].join('\n'),
        'HEAD -> main, origin/main',
      ].join(GIT_LOG_FIELD_SEPARATOR) + GIT_LOG_RECORD_SEPARATOR;

    expect(parseGitLogOutput(output)).toEqual([
      {
        hash: 'abc123',
        date: '2026-03-24 10:38:45 +0800',
        author_name: 'Test Author',
        author_email: 'test@example.com',
        message: 'feat(workflow/approval): 增加可配置审批附件非修正附件预下载策略',
        fullMessage: [
          'feat(workflow/approval): 增加可配置审批附件非修正附件预下载策略',
          '',
          '- 增加预下载开关',
          '- 修复历史回显不完整',
        ].join('\n'),
        refs: 'main, origin/main',
      },
    ]);
  });

  it('strips the newline that git emits between records from the next hash', () => {
    // Git prints `<record>\x1e\n<record>\x1e\n...`, so splitting by \x1e leaves
    // every record after the first with a leading \n that would otherwise end
    // up in the hash field and break downstream ref lookups.
    const recordA = ['abc123', '2026-03-24 10:00:00 +0800', 'A', 'a@x', 'msg A', 'msg A', ''].join(
      GIT_LOG_FIELD_SEPARATOR
    );
    const recordB = ['def456', '2026-03-24 11:00:00 +0800', 'B', 'b@x', 'msg B', 'msg B', ''].join(
      GIT_LOG_FIELD_SEPARATOR
    );
    const output = `${recordA}${GIT_LOG_RECORD_SEPARATOR}\n${recordB}${GIT_LOG_RECORD_SEPARATOR}\n`;

    const parsed = parseGitLogOutput(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].hash).toBe('abc123');
    expect(parsed[1].hash).toBe('def456');
  });

  it('falls back to subject when full message is empty', () => {
    const output =
      [
        'def456',
        '2026-03-24 11:00:00 +0800',
        'baseOnEnso',
        'admin@123.com',
        'fix(editor): 修复路径解析错误',
        '',
        '',
      ].join(GIT_LOG_FIELD_SEPARATOR) + GIT_LOG_RECORD_SEPARATOR;

    expect(parseGitLogOutput(output)).toEqual([
      {
        hash: 'def456',
        date: '2026-03-24 11:00:00 +0800',
        author_name: 'baseOnEnso',
        author_email: 'admin@123.com',
        message: 'fix(editor): 修复路径解析错误',
        fullMessage: 'fix(editor): 修复路径解析错误',
        refs: undefined,
      },
    ]);
  });
});
