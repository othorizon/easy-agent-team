import type { LoginResponse, RegistrationSettings } from '@eat/shared';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, setSession } from '../api';
import { Field, rules } from '../components/form';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

interface FormValues {
  name?: string;
  email: string;
  password: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registration, setRegistration] = useState<RegistrationSettings | null>(null);

  useEffect(() => {
    api<RegistrationSettings>('GET', '/api/auth/registration')
      .then(setRegistration)
      .catch(() => setRegistration(null));
  }, []);

  const suffixes = registration?.allowedEmailSuffixes ?? [];

  const form = useForm<FormValues>({ defaultValues: { name: '', email: '', password: '' } });
  const { register, handleSubmit, formState: { errors }, clearErrors } = form;

  async function onSubmit(values: FormValues) {
    setLoading(true);
    try {
      const res =
        mode === 'register'
          ? await api<LoginResponse>('POST', '/api/auth/register', values)
          : await api<LoginResponse>('POST', '/api/auth/login', {
              email: values.email,
              password: values.password,
            });
      setSession(res.token, res.user);
      navigate(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : mode === 'register' ? '注册失败' : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-primary/6 via-background to-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary font-mono text-xl font-bold text-primary-foreground shadow-md">
            e
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">easy-agent-team</h1>
            <p className="mt-1 text-sm text-muted-foreground">团队 AI 能力集中管理与分发平台</p>
          </div>
        </div>
        <Card>
          <CardContent className="pt-5">
            <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
              {mode === 'register' && (
                <Field label="姓名" htmlFor="name" required error={errors.name?.message}>
                  <Input
                    id="name"
                    autoFocus
                    placeholder="张三"
                    aria-invalid={!!errors.name}
                    {...register('name', { required: '请输入姓名' })}
                  />
                </Field>
              )}
              <Field
                label="邮箱"
                htmlFor="email"
                required
                error={errors.email?.message}
                hint={mode === 'register' && suffixes.length > 0 ? `仅允许 ${suffixes.join(' / ')} 后缀的邮箱` : undefined}
              >
                <Input
                  id="email"
                  type="email"
                  autoFocus={mode === 'login'}
                  autoComplete="email"
                  placeholder={suffixes.length > 0 ? `you${suffixes[0]}` : 'you@team.com'}
                  aria-invalid={!!errors.email}
                  {...register('email', {
                    required: '请输入邮箱',
                    pattern: rules.email,
                    validate: (v) =>
                      mode !== 'register' ||
                      suffixes.length === 0 ||
                      suffixes.some((s) => v.toLowerCase().endsWith(s)) ||
                      `仅允许 ${suffixes.join(' / ')} 后缀的邮箱`,
                  })}
                />
              </Field>
              <Field label="密码" htmlFor="password" required error={errors.password?.message}>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  aria-invalid={!!errors.password}
                  {...register('password', {
                    required: '请输入密码',
                    ...(mode === 'register' ? { minLength: { value: 8, message: '至少 8 位' } } : {}),
                  })}
                />
              </Field>
              <Button type="submit" loading={loading} className="mt-1 w-full">
                {mode === 'register' ? '注册并登录' : '登录'}
              </Button>
            </form>
            {registration?.enabled && (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                {mode === 'login' ? '没有账号？' : '已有账号？'}
                <button
                  type="button"
                  className="ml-1 font-medium text-primary hover:underline cursor-pointer"
                  onClick={() => {
                    clearErrors();
                    setMode(mode === 'login' ? 'register' : 'login');
                  }}
                >
                  {mode === 'login' ? '注册' : '登录'}
                </button>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
