import type { RegistrationSettings } from '@eat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { Field } from '../components/form';
import { TagsInput } from '../components/tags-input';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export function RegistrationSettingsCard() {
  const settings = useQuery({
    queryKey: ['registration-settings'],
    queryFn: () => api<RegistrationSettings>('GET', '/api/admin/registration-settings'),
  });
  if (settings.isError) return <div className="space-y-3"><p>注册与登录设置加载失败</p><Button onClick={() => void settings.refetch()}>重试</Button></div>;
  if (!settings.data) return <p className="text-muted-foreground">正在加载设置…</p>;
  return <RegistrationForm settings={settings.data} />;
}

function RegistrationForm({ settings }: { settings: RegistrationSettings }) {
  const client = useQueryClient();
  const [values, setValues] = useState(settings);
  const save = useMutation({
    mutationFn: () => api('PUT', '/api/admin/registration-settings', values),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['registration-settings'] });
      toast.success('注册与登录设置已保存');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return <Card>
    <CardHeader><CardTitle>注册与登录</CardTitle></CardHeader>
    <CardContent><form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="开放注册" hint="开启后允许新成员从登录页面自助注册。">
        <Switch aria-label="开放注册" checked={values.enabled} onCheckedChange={(enabled) => setValues((v) => ({ ...v, enabled }))} />
      </Field>
      <Field label="允许的邮箱后缀" hint="回车添加，如 @example.com；留空表示任意邮箱。">
        <TagsInput value={values.allowedEmailSuffixes} onChange={(allowedEmailSuffixes) => setValues((v) => ({ ...v, allowedEmailSuffixes }))} placeholder="@example.com" />
      </Field>
      <div className="space-y-5 border-t pt-5">
        <p className="text-sm leading-6 text-muted-foreground">以下两项独立生效，不阻止用户注册。开启后，新老普通用户进入网站时都必须完成对应配置；管理员免于强制，CLI 与 MCP 使用不受影响。</p>
        <Field label="强制填写个人简介" hint="未填写时跳转到独立补全页。个人简介会用于 AI 查询用户。">
          <Switch aria-label="强制填写个人简介" checked={values.requireBio} onCheckedChange={(requireBio) => setValues((v) => ({ ...v, requireBio }))} />
        </Field>
        <Field label="强制配置飞书通知" hint="必须通过飞书群验证码验证；仅填写 Webhook 地址不算完成。">
          <Switch aria-label="强制配置飞书通知" checked={values.requireNotification} onCheckedChange={(requireNotification) => setValues((v) => ({ ...v, requireNotification }))} />
        </Field>
      </div>
      <Button type="submit" loading={save.isPending}>保存设置</Button>
    </form></CardContent>
  </Card>;
}
