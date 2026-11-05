# -*- coding: utf-8 -*-
"""用 Actions 注入的 OSS AccessKey 生成 10 年有效期预签名 URL，输出 oss-config.js
   该文件仅在 CI 中生成，随站点发布，不进入 Git 仓库。"""
import os
import oss2


def main():
    ak = os.environ.get('OSS_AK_ID', '')
    sk = os.environ.get('OSS_AK_SECRET', '')
    bucket_name = os.environ.get('OSS_BUCKET', '')
    endpoint = os.environ.get('OSS_ENDPOINT', '')
    # OSS_BACKUP_KEY 是长随机串（存于 Secrets），决定唯一的备份对象名，必须跨部署保持不变
    key = os.environ.get('OSS_BACKUP_KEY', '').strip().strip('/')
    if not key:
        key = 'health-backup'
    object_key = f'backup/{key}.json'

    auth = oss2.Auth(ak, sk)
    # endpoint 未带协议时 oss2 默认用 http，会造成 https 页面的混合内容拦截，强制 https
    if not endpoint.startswith(('http://', 'https://')):
        endpoint = 'https://' + endpoint
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    expires = 10 * 365 * 24 * 3600  # 10 年有效期
    put_url = bucket.sign_url('PUT', object_key, expires, slash_safe=True)
    get_url = bucket.sign_url('GET', object_key, expires, slash_safe=True)

    js = (
        '// 该文件由 GitHub Actions 部署时自动生成，请勿手动修改或提交到仓库\n'
        f'window.OSS_CONFIG = {{ putUrl: "{put_url}", getUrl: "{get_url}" }};\n'
    )
    with open('oss-config.js', 'w', encoding='utf-8') as f:
        f.write(js)
    print('oss-config.js generated, object:', object_key)


if __name__ == '__main__':
    main()
