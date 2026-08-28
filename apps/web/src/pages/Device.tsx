import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../api';
import { InlineCode } from '../components/code';
import { Field } from '../components/form';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

interface FormValues {
  userCode: string;
  tokenName?: string;
}

/** CLI 设备码授权确认页：eat login 引导用户到 /device 输入代码 */
export function DevicePage() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    defaultValues: { userCode: params.get('code') ?? '', tokenName: '' },
  });

  async function onSubmit(values: FormValues) {
    setLoading(true);
    try {
      await api('POST', '/api/auth/device/approve', {
        userCode: values.userCode.toUpperCase().trim(),
        tokenName: values.tokenName || undefined,
      });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '授权失败');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
        <CheckCircle2 className="size-14 text-success" strokeWidth={1.5} />
        <div>
          <h1 className="text-xl font-semibold">授权成功</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            回到终端即可，CLI 会自动完成登录。此页面可以关闭。
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            reset({ userCode: '', tokenName: '' });
            setDone(false);
          }}
        >
          继续授权其他设备
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-6">
      <h1 className="text-xl font-semibold tracking-tight">设备授权</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        在终端运行 <InlineCode>eat login</InlineCode> 后，把终端里显示的代码输入到这里，即为该设备上的 CLI / MCP
        授权访问你的账号。
      </p>
      <Card className="mt-5">
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
            <Field label="设备代码" htmlFor="userCode" required error={errors.userCode?.message}>
              <Input
                id="userCode"
                autoFocus
                placeholder="例如 AB2C-3DEF"
                className="font-mono tracking-[0.15em] uppercase"
                aria-invalid={!!errors.userCode}
                {...register('userCode', { required: '请输入终端显示的代码' })}
              />
            </Field>
            <Field
              label="设备备注"
              htmlFor="tokenName"
              hint="可选，便于以后在 Token 列表辨认"
            >
              <Input id="tokenName" placeholder="例如 我的工作笔记本" {...register('tokenName')} />
            </Field>
            <Button type="submit" loading={loading} className="w-full">
              确认授权
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
