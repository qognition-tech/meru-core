import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import {
  Notification,
  NotificationPreference,
  NotificationTemplate,
} from './entities/notification.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';

/**
 * `notification_templates` was empty on production, so every template-driven
 * message threw `Template not found` and `GET /notifications/templates`
 * returned `[]` — which reads to a UI as "this tenant has no templates" rather
 * than "nobody seeded the table". Templates now default from the vertical pack.
 */
describe('NotificationsService template resolution', () => {
  const templateFindOne = jest.fn();
  const templateFind = jest.fn();
  const notificationCreate = jest.fn((x: unknown) => x);
  const notificationSave = jest.fn((x: unknown) => Promise.resolve(x));
  const preferenceFindOne = jest.fn();
  const sectionWithPack = jest.fn();
  const section = jest.fn();
  let service: NotificationsService;

  const packTemplate = {
    key: 'payment_due',
    name: 'Payment due',
    channel: 'email',
    subject: '{{firmName}} — {{amountFormatted}} due',
    body: 'Hello {{firstName}}, you owe {{amountFormatted}}.',
    variables: ['firstName', 'firmName', 'amountFormatted'],
  };

  beforeEach(async () => {
    [
      templateFindOne,
      templateFind,
      preferenceFindOne,
      sectionWithPack,
      section,
    ].forEach((m) => m.mockReset());
    notificationCreate.mockClear();
    notificationSave.mockClear();
    // No stored preference → nothing suppresses the send.
    preferenceFindOne.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: { create: notificationCreate, save: notificationSave },
        },
        {
          provide: getRepositoryToken(NotificationPreference),
          useValue: {
            findOne: preferenceFindOne,
            // With no stored row the service creates default preferences,
            // which is the path a first-ever notification takes.
            create: (x: unknown) => x,
            save: (x: unknown) => Promise.resolve(x),
          },
        },
        {
          provide: getRepositoryToken(NotificationTemplate),
          useValue: { findOne: templateFindOne, find: templateFind },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: VerticalPackService, useValue: { sectionWithPack, section } },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);
  });

  it('renders a pack template when the tenant has no row', async () => {
    templateFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'au-immigration' },
      section: { templates: [packTemplate] },
    });

    await service.sendFromTemplate(
      't1',
      'payment_due',
      'user-1',
      { firstName: 'Sam', firmName: 'Acme Migration', amountFormatted: 'A$450.00' },
      'immigration',
    );

    const saved = notificationSave.mock.calls[0][0] as {
      subject: string;
      content: string;
      templateData: { source: string; templateKey: string };
    };

    expect(saved.subject).toBe('Acme Migration — A$450.00 due');
    expect(saved.content).toBe('Hello Sam, you owe A$450.00.');
    // Provenance is recorded because a pack template has no row id, so without
    // the key there would be no way to tell afterwards what rendered this.
    expect(saved.templateData.source).toBe('config_pack');
    expect(saved.templateData.templateKey).toBe('payment_due');
  });

  it('prefers a tenant row over the pack entry', async () => {
    templateFindOne.mockResolvedValue({
      id: 'row-1',
      key: 'payment_due',
      name: 'Custom',
      type: 'email',
      subject: 'OVERRIDE {{amountFormatted}}',
      content: 'Custom body {{firstName}}',
      variables: [],
    });

    await service.sendFromTemplate(
      't1',
      'payment_due',
      'user-1',
      { firstName: 'Sam', amountFormatted: 'A$450.00' },
      'immigration',
    );

    const saved = notificationSave.mock.calls[0][0] as {
      subject: string;
      templateData: { source: string };
    };
    expect(saved.subject).toBe('OVERRIDE A$450.00');
    expect(saved.templateData.source).toBe('tenant_override');
    expect(sectionWithPack).not.toHaveBeenCalled();
  });

  it('names both layers it checked when the template is nowhere', async () => {
    templateFindOne.mockResolvedValue(null);
    sectionWithPack.mockResolvedValue({
      pack: { code: 'ae-banking' },
      section: { templates: [] },
    });

    const call = service.sendFromTemplate('t1', 'nope', 'user-1', {}, 'banking');

    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    // "Template not found" alone sent whoever hit it looking for a bug in the
    // caller instead of at an unpopulated table and an un-authored pack.
    await expect(call).rejects.toThrow(/ae-banking/);
  });

  it('lists pack templates alongside tenant rows, with the row shadowing', async () => {
    templateFind.mockResolvedValue([
      {
        id: 'row-1',
        key: 'payment_due',
        name: 'Custom',
        type: 'email',
        subject: 's',
        content: 'c',
        variables: [],
      },
    ]);
    section.mockResolvedValue({
      templates: [packTemplate, { ...packTemplate, key: 'task_assigned' }],
    });

    const list = await service.getTemplates('t1', undefined, 'immigration');

    expect(list.map((t) => `${t.key}:${t.source}`)).toEqual([
      'payment_due:tenant_override',
      'task_assigned:config_pack',
    ]);
    // Null rather than a fabricated id: PATCH on a pack template would 404, so
    // handing back an id would be a lie the UI acts on.
    expect(list.find((t) => t.source === 'config_pack')?.id).toBeNull();
  });

  it('filters pack templates by channel when a type is requested', async () => {
    templateFind.mockResolvedValue([]);
    section.mockResolvedValue({
      templates: [packTemplate, { ...packTemplate, key: 'sms_one', channel: 'sms' }],
    });

    const list = await service.getTemplates('t1', 'sms', 'immigration');

    expect(list.map((t) => t.key)).toEqual(['sms_one']);
  });

  it('degrades to DB-only when no vertical is known', async () => {
    templateFind.mockResolvedValue([]);
    section.mockResolvedValue(null);

    await expect(service.getTemplates('t1')).resolves.toEqual([]);
  });
});
