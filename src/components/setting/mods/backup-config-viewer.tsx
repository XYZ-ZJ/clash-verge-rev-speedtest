import { Button, Grid, Stack, TextField } from '@mui/material'
import { useLockFn } from 'ahooks'
import { memo, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { useVerge } from '@/hooks/use-verge'
import { createWebdavBackup, saveWebdavConfig } from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { errorDetail, showNotice } from '@/services/notice-service'
import {
  buildWebdavSignature,
  getWebdavStatus,
  setWebdavStatus,
  useWebdavSignatureState,
} from '@/services/webdav-status'
import { isValidUrl } from '@/utils/network'

interface BackupConfigViewerProps {
  onBackupSuccess: () => Promise<void>
  onSaveSuccess: (signature?: string) => Promise<void>
  onRefresh: () => Promise<void>
  onInit: () => Promise<void>
  setLoading: (loading: boolean) => void
}

export const BackupConfigViewer = memo(
  ({
    onBackupSuccess,
    onSaveSuccess,
    onRefresh,
    onInit,
    setLoading,
  }: BackupConfigViewerProps) => {
    const { t } = useTranslation()
    const { verge, mutateVerge } = useVerge()
    const { webdav_url, webdav_username, webdav_password } = verge || {}
    const usernameRef = useRef<HTMLInputElement>(null)
    const passwordRef = useRef<HTMLInputElement>(null)
    const urlRef = useRef<HTMLInputElement>(null)

    const {
      register,
      handleSubmit,
      watch,
      reset,
      formState: { isDirty },
    } = useForm<IWebDavConfig>({
      defaultValues: {
        url: webdav_url ?? '',
        username: webdav_username ?? '',
        password: webdav_password ?? '',
      },
    })

    useEffect(() => {
      if (!isDirty) {
        reset({
          url: webdav_url ?? '',
          username: webdav_username ?? '',
          password: webdav_password ?? '',
        })
      }
    }, [isDirty, reset, webdav_url, webdav_username, webdav_password])
    const url = watch('url')
    const username = watch('username')
    const password = watch('password')

    const webdavChanged =
      (webdav_url ?? '') !== url ||
      (webdav_username ?? '') !== username ||
      (webdav_password ?? '') !== password

    const { signature: webdavSignature, ready: webdavSignatureReady } =
      useWebdavSignatureState(verge)
    const webdavStatus = getWebdavStatus(webdavSignature)
    const shouldAutoInit = webdavSignatureReady && webdavStatus !== 'failed'

    useEffect(() => {
      if (!webdav_url || !webdav_username || !webdav_password) {
        return
      }
      if (!shouldAutoInit) {
        return
      }
      void onInit()
    }, [webdav_url, webdav_username, webdav_password, onInit, shouldAutoInit])

    const checkForm = () => {
      const username = usernameRef.current?.value.trim()
      const password = passwordRef.current?.value
      const url = urlRef.current?.value.trim()

      if (!url) {
        urlRef.current?.focus()
        showNotice.error('settings.modals.backup.messages.webdavUrlRequired')
        throw new Error(t('settings.modals.backup.messages.webdavUrlRequired'))
      } else if (!isValidUrl(url)) {
        urlRef.current?.focus()
        showNotice.error('settings.modals.backup.messages.invalidWebdavUrl')
        throw new Error(t('settings.modals.backup.messages.invalidWebdavUrl'))
      }
      if (!username) {
        usernameRef.current?.focus()
        showNotice.error('settings.modals.backup.messages.usernameRequired')
        throw new Error(t('settings.modals.backup.messages.usernameRequired'))
      }
      if (!password) {
        passwordRef.current?.focus()
        showNotice.error('settings.modals.backup.messages.passwordRequired')
        throw new Error(t('settings.modals.backup.messages.passwordRequired'))
      }
    }

    const save = useLockFn(async (data: IWebDavConfig) => {
      const trimmedUrl = data.url.trim()
      const trimmedUsername = data.username.trim()
      const isClearing = !trimmedUrl && !trimmedUsername && !data.password
      try {
        if (!isClearing) checkForm()
        const signature = await buildWebdavSignature({
          webdav_url: trimmedUrl,
          webdav_username: trimmedUsername,
          webdav_password: data.password,
        })

        setLoading(true)
        await mutate(
          () => saveWebdavConfig(trimmedUrl, trimmedUsername, data.password),
          {
            id: 'save-webdav-config',
            errorNotice: false,
          },
        )
        mutateVerge((current) =>
          current
            ? {
                ...current,
                webdav_url: trimmedUrl,
                webdav_username: trimmedUsername,
                webdav_password: data.password,
              }
            : current,
        )
        reset({
          url: trimmedUrl,
          username: trimmedUsername,
          password: data.password,
        })
        setWebdavStatus(signature, 'unknown')
        showNotice.success('settings.modals.backup.messages.webdavConfigSaved')
        if (!isClearing) await onSaveSuccess(signature)
      } catch (error) {
        const detail = errorDetail(error)
        if (detail) {
          showNotice.error(
            'settings.modals.backup.messages.webdavConfigSaveFailed',
            { error: detail },
            3000,
          )
        }
      } finally {
        setLoading(false)
      }
    })

    const handleBackup = useLockFn(async () => {
      let signature = ''
      try {
        checkForm()
        signature = await buildWebdavSignature({
          webdav_url: url,
          webdav_username: username,
          webdav_password: password,
        })
        setLoading(true)
        await mutate(() => createWebdavBackup(), {
          id: 'create-webdav-backup',
          errorNotice: false,
        }).then(async () => {
          showNotice.success('settings.modals.backup.messages.backupCreated')
          await onBackupSuccess()
        })
        setWebdavStatus(signature, 'ready')
      } catch (error) {
        showNotice.error('settings.modals.backup.messages.backupFailed', {
          error,
        })
        if (signature) {
          setWebdavStatus(signature, 'failed')
        }
      } finally {
        setLoading(false)
      }
    })

    return (
      <form onSubmit={(e) => e.preventDefault()}>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 9 }}>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12 }}>
                <TextField
                  fullWidth
                  label={t('settings.modals.backup.fields.webdavUrl')}
                  variant="outlined"
                  size="small"
                  {...register('url')}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  inputRef={urlRef}
                  sx={{ mt: 1 }}
                />
              </Grid>
              <Grid size={{ xs: 6 }}>
                <TextField
                  label={t('settings.modals.backup.fields.username')}
                  variant="outlined"
                  size="small"
                  {...register('username')}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  inputRef={usernameRef}
                />
              </Grid>
              <Grid size={{ xs: 6 }}>
                <TextField
                  label={t('shared.labels.password')}
                  type="password"
                  variant="outlined"
                  size="small"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  inputRef={passwordRef}
                  {...register('password')}
                />
              </Grid>
            </Grid>
          </Grid>
          <Grid size={{ xs: 12, sm: 3 }}>
            <Stack
              direction="column"
              sx={{
                justifyContent: 'space-between',
                alignItems: 'stretch',
                height: '100%',
              }}
            >
              {webdavChanged ||
              !webdav_url ||
              !webdav_username ||
              !webdav_password ? (
                <Button
                  variant="contained"
                  color={'primary'}
                  sx={{ height: '100%' }}
                  type="button"
                  onClick={handleSubmit(save)}
                >
                  {t('shared.actions.save')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="contained"
                    color="success"
                    onClick={handleBackup}
                    type="button"
                    size="large"
                  >
                    {t('settings.modals.backup.actions.backup')}
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={onRefresh}
                    type="button"
                    size="large"
                  >
                    {t('shared.actions.refresh')}
                  </Button>
                </>
              )}
            </Stack>
          </Grid>
        </Grid>
      </form>
    )
  },
)
