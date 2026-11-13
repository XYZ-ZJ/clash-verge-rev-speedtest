import {
  CancelRounded,
  CheckCircleRounded,
  CloseOutlined,
  LanguageOutlined,
  OpenInFullOutlined,
  RefreshOutlined,
  VisibilityOffOutlined,
  VisibilityOutlined,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/material'
import { memo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  EgressItem,
  EgressReport,
  FindingItem,
  runFullEgressDetection,
} from '@/services/egress'
import getSystem from '@/utils/get-system'

interface Props {
  open: boolean
  onClose: () => void
}

const getCountryFlag = (countryCode: string | undefined) => {
  if (!countryCode) return ''
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

// 缓存检测结果，避免每次关闭再打开都重新发请求，严格支持手动刷新
let cachedReport: EgressReport | null = null

export const IpDetailModal = memo(({ open, onClose }: Props) => {
  const { t } = useTranslation()
  const [report, setReport] = useState<EgressReport | null>(cachedReport)
  const [loading, setLoading] = useState(false)
  const [cfLoading, setCfLoading] = useState(false)
  const [hideIp, setHideIp] = useState(false)

  const handleDetect = useCallback(async () => {
    setLoading(true)
    try {
      const res = await runFullEgressDetection()
      cachedReport = res
      setReport(res)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRetestCf = useCallback(async () => {
    setCfLoading(true)
    try {
      // 局部重新探测海外出口与 CF 状态
      const res = await runFullEgressDetection()
      cachedReport = res
      setReport(res)
    } finally {
      setCfLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && !report && !loading) {
      handleDetect()
    }
  }, [open, report, loading, handleDetect])

  const cfState = report?.cfStatus.state || 'pass'
  const isCfPass = cfState === 'pass'
  const isCfWarn = cfState === 'interactive'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          backgroundImage: 'none',
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? '0 12px 40px rgba(0, 0, 0, 0.6)'
              : '0 12px 40px rgba(0, 0, 0, 0.12)',
        },
      }}
    >
      <DialogTitle
        sx={{
          py: 2,
          px: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2 }}>
          <LanguageOutlined sx={{ color: 'primary.main', fontSize: 24 }} />
          <Typography variant="h6" sx={{ fontWeight: 600, fontSize: '1.05rem' }}>
            {t('home.components.ipInfo.detailModal.title')}
          </Typography>
          {report?.timestamp && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ ml: 1, display: { xs: 'none', sm: 'inline-block' } }}
            >
              {t('home.components.ipInfo.detailModal.lastCheck')}:{' '}
              {new Date(report.timestamp).toLocaleTimeString()}
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={handleDetect}
            disabled={loading}
            startIcon={
              loading ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <RefreshOutlined fontSize="small" />
              )
            }
            sx={{ textTransform: 'none', borderRadius: 1.5 }}
          >
            {loading
              ? t('home.components.ipInfo.detailModal.testing')
              : t('home.components.ipInfo.detailModal.refresh')}
          </Button>
          <IconButton size="small" onClick={onClose} sx={{ color: 'text.secondary' }}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: { xs: 2, sm: 3 } }}>
        {/* 模块一：实测 CLOUDFLARE 人机验证 */}
        <Box sx={{ mb: 3 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 700,
              fontSize: '0.85rem',
              color: 'text.secondary',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              mb: 1.2,
            }}
          >
            {t('home.components.ipInfo.detailModal.cfTitle')}
          </Typography>

          <Box
            sx={{
              p: 2,
              borderRadius: 2,
              border: 1,
              borderColor: 'divider',
              borderLeft: '4px solid',
              borderLeftColor: isCfPass
                ? 'success.main'
                : isCfWarn
                  ? 'warning.main'
                  : 'error.main',
              bgcolor: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(255, 255, 255, 0.03)'
                  : 'rgba(0, 0, 0, 0.02)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 2,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flex: 1 }}>
              {loading && !report ? (
                <Skeleton variant="circular" width={26} height={26} />
              ) : isCfPass ? (
                <CheckCircleRounded
                  sx={{ color: 'success.main', fontSize: 26, mt: 0.2 }}
                />
              ) : isCfWarn ? (
                <WarningAmberRounded
                  sx={{ color: 'warning.main', fontSize: 26, mt: 0.2 }}
                />
              ) : (
                <CancelRounded
                  sx={{ color: 'error.main', fontSize: 26, mt: 0.2 }}
                />
              )}

              <Box sx={{ flex: 1 }}>
                {loading && !report ? (
                  <>
                    <Skeleton variant="text" width={100} height={26} />
                    <Skeleton variant="text" width="80%" height={20} />
                  </>
                ) : (
                  <>
                    <Typography
                      variant="subtitle1"
                      sx={{
                        fontWeight: 700,
                        color: isCfPass
                          ? 'success.main'
                          : isCfWarn
                            ? 'warning.main'
                            : 'error.main',
                        lineHeight: 1.3,
                      }}
                    >
                      {report?.cfStatus.title || '直接通过'}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.primary"
                      sx={{ mt: 0.5, lineHeight: 1.5 }}
                    >
                      {report?.cfStatus.description ||
                        '大多数用 Cloudflare 防护的网站会直接放行你，不弹验证。'}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.3 }}
                    >
                      和上面按 IP 的推测一致：这个 IP 的信誉不错。
                    </Typography>
                  </>
                )}
              </Box>
            </Box>

            <Button
              variant="outlined"
              size="small"
              onClick={handleRetestCf}
              disabled={cfLoading || loading}
              startIcon={
                cfLoading ? <CircularProgress size={14} color="inherit" /> : null
              }
              sx={{
                textTransform: 'none',
                borderRadius: 1.5,
                borderColor: 'divider',
                color: 'text.primary',
                px: 2,
                '&:hover': {
                  borderColor: 'primary.main',
                },
              }}
            >
              {t('home.components.ipInfo.detailModal.retest')}
            </Button>
          </Box>
        </Box>

        {/* 模块二：分流透视 */}
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 1.5,
              flexWrap: 'wrap',
              gap: 1,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 700, fontSize: '0.98rem' }}
              >
                {report?.title || '分流透视'}
              </Typography>
              {report?.isSplit && (
                <Chip
                  size="small"
                  label="分流生效"
                  color="success"
                  variant="outlined"
                  sx={{ height: 22, fontSize: '0.72rem', fontWeight: 600 }}
                />
              )}
            </Box>
          </Box>

          <Grid container spacing={2.5}>
            {/* 左栏：你的出口 */}
            <Grid item xs={12} md={5.5}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mb: 1,
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    color: 'text.secondary',
                    letterSpacing: 0.5,
                  }}
                >
                  {t('home.components.ipInfo.detailModal.exitsTitle')}
                </Typography>
                <Button
                  size="small"
                  onClick={() => setHideIp(!hideIp)}
                  startIcon={
                    hideIp ? (
                      <VisibilityOutlined fontSize="inherit" />
                    ) : (
                      <VisibilityOffOutlined fontSize="inherit" />
                    )
                  }
                  sx={{
                    p: 0,
                    minWidth: 'auto',
                    fontSize: '0.72rem',
                    color: 'text.secondary',
                    textTransform: 'none',
                  }}
                >
                  {hideIp
                    ? t('home.components.ipInfo.detailModal.showIp')
                    : t('home.components.ipInfo.detailModal.hideIp')}
                </Button>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
                {loading && !report ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <Skeleton
                      key={idx}
                      variant="rounded"
                      height={68}
                      sx={{ borderRadius: 2 }}
                    />
                  ))
                ) : report?.exits && report.exits.length > 0 ? (
                  report.exits.map((item) => (
                    <ExitCard key={item.id} item={item} hideIp={hideIp} />
                  ))
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    未检测到出口
                  </Typography>
                )}
              </Box>
            </Grid>

            {/* 右栏：检测结论 */}
            <Grid item xs={12} md={6.5}>
              <Box sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    color: 'text.secondary',
                    letterSpacing: 0.5,
                  }}
                >
                  {t('home.components.ipInfo.detailModal.findingsTitle')}
                </Typography>
              </Box>

              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: (theme) =>
                    theme.palette.mode === 'dark'
                      ? 'rgba(255, 255, 255, 0.02)'
                      : 'rgba(0, 0, 0, 0.01)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.2,
                }}
              >
                {loading && !report ? (
                  Array.from({ length: 5 }).map((_, idx) => (
                    <Skeleton key={idx} variant="text" height={32} />
                  ))
                ) : report?.findings && report.findings.length > 0 ? (
                  report.findings.map((item, idx) => (
                    <FindingRow
                      key={item.key}
                      item={item}
                      isLast={idx === report.findings.length - 1}
                    />
                  ))
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    无结论
                  </Typography>
                )}
              </Box>
            </Grid>
          </Grid>
        </Box>
      </DialogContent>
    </Dialog>
  )
})

interface ExitCardProps {
  item: EgressItem
  hideIp: boolean
}

const ExitCard = memo(({ item, hideIp }: ExitCardProps) => {
  return (
    <Box
      sx={{
        p: 1.2,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.025)'
            : 'rgba(0, 0, 0, 0.015)',
        display: 'flex',
        alignItems: 'center',
        gap: 1.2,
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 1.5,
          border: 1,
          borderColor: item.isProxy ? 'primary.main' : 'success.main',
          color: item.isProxy ? 'primary.main' : 'success.main',
          bgcolor: (theme) =>
            item.isProxy
              ? theme.palette.mode === 'dark'
                ? 'rgba(25, 118, 210, 0.12)'
                : 'rgba(25, 118, 210, 0.08)'
              : theme.palette.mode === 'dark'
                ? 'rgba(46, 125, 50, 0.12)'
                : 'rgba(46, 125, 50, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: '0.85rem',
          flexShrink: 0,
        }}
      >
        {item.id}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box
            component="span"
            sx={{
              fontSize: '1rem',
              display: 'inline-block',
              fontFamily:
                getSystem() === 'windows'
                  ? '"twemoji mozilla", sans-serif'
                  : 'sans-serif',
            }}
          >
            {getCountryFlag(item.countryCode)}
          </Box>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {[item.city, item.country].filter(Boolean).join(', ') || item.country}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            · {[item.isp, item.asn].filter(Boolean).join(' · ')}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, mt: 0.2 }}>
          <Chip
            size="small"
            label={item.type}
            variant="outlined"
            sx={{
              height: 18,
              fontSize: '0.65rem',
              fontWeight: 600,
              '& .MuiChip-label': { px: 0.6 },
            }}
          />
          <Typography
            variant="caption"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              color: 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {hideIp ? '••••••••••' : item.ip}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
})

interface FindingRowProps {
  item: FindingItem
  isLast: boolean
}

const FindingRow = memo(({ item, isLast }: FindingRowProps) => {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        pb: isLast ? 0 : 1,
        borderBottom: isLast ? 0 : 1,
        borderColor: 'divider',
      }}
    >
      {/* 正常绿色对勾，问题红色叉号 */}
      {item.ok ? (
        <CheckCircleRounded
          sx={{
            color: 'success.main',
            fontSize: 18,
            mt: 0.3,
            flexShrink: 0,
          }}
        />
      ) : (
        <CancelRounded
          sx={{
            color: 'error.main',
            fontSize: 18,
            mt: 0.3,
            flexShrink: 0,
          }}
        />
      )}

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.8,
            flexWrap: 'wrap',
          }}
        >
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              minWidth: 80,
              color: 'text.secondary',
              flexShrink: 0,
            }}
          >
            {item.label}
          </Typography>

          {item.badge && (
            <Chip
              size="small"
              label={item.badge}
              color={item.ok ? 'success' : 'error'}
              variant="outlined"
              sx={{
                height: 20,
                fontSize: '0.68rem',
                fontWeight: 600,
                '& .MuiChip-label': { px: 0.6 },
              }}
            />
          )}

          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              color: item.ok ? 'text.primary' : 'error.main',
              wordBreak: 'break-word',
              flex: 1,
            }}
          >
            {item.text}
          </Typography>
        </Box>

        {item.helpText && (
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mt: 0.4,
              color: item.ok ? 'text.secondary' : 'error.main',
              fontSize: '0.72rem',
              lineHeight: 1.4,
            }}
          >
            {item.helpText}
          </Typography>
        )}
      </Box>
    </Box>
  )
})
