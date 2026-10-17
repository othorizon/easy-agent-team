/** Public contract checked against the official feature parameter examples (2026-10-17).
 * https://help.aliyun.com/zh/cdn/developer-reference/parameters-for-configuring-features-for-domain-names
 * origin_certificate_verification: the example uses enable; enabled is the table's alternate spelling.
 * Argument names do not imply wildcard availability: ordinary CDN does not support wildcard
 * origin request header changes or outbound response header changes. Cloud substitutes model
 * the state machine under that capability assumption and cannot prove production compatibility.
 */
export const aliyunCdnContract: Record<string, { required: string[]; optional?: string[] }> = {
  forward_scheme: { required: ['enable'], optional: ['scheme_origin', 'scheme_origin_port'] },
  https_origin_sni: { required: ['enabled', 'https_origin_sni'] },
  origin_certificate_verification: { required: ['enable'], optional: ['common_name_whitelist'] },
  origin_request_header: {
    required: ['header_operation_type', 'header_name'],
    optional: ['header_value', 'duplicate', 'header_source', 'header_destination', 'match_all'],
  },
  cdn_remote_auth: {
    required: [
      'enable', 'remote_auth_addr', 'remote_auth_method', 'remote_auth_type',
      'remote_auth_reserve_args', 'remote_auth_reserve_header', 'remote_auth_success_code',
      'remote_auth_fail_code', 'remote_auth_fail_resp_code', 'remote_auth_timeout',
      'remote_auth_timeout_action',
    ],
    optional: ['remote_auth_custom_args', 'remote_auth_custom_header', 'remote_auth_other_code_act'],
  },
  path_based_ttl_set: {
    required: ['ttl', 'path'],
    optional: ['weight', 'swift_origin_cache_high', 'swift_no_cache_low', 'swift_follow_cachetime', 'force_revalidate'],
  },
  self_defined_cachekey: { required: [], optional: ['uri', 'args', 'headers', 'variable'] },
  set_resp_header: {
    required: ['key', 'value'],
    optional: ['header_operation_type', 'duplicate', 'header_source', 'header_destination', 'match_all', 'access_origin_control'],
  },
};
